import { createHash } from 'crypto'
import { z } from 'zod/v3'
import { StructuredTool } from '@langchain/core/tools'
import { secureFetch } from '../../../src/httpSecurity'

type SecureFetch = (url: string, init?: any) => Promise<any>

export const SPECSTREAM_BASE_URL = 'https://api.specstream.ai'
export const MAX_RESULTS = 1000
export const DEFAULT_WAIT_SECONDS = 300
const POLL_INTERVAL_MS = 3000
const REQUEST_TIMEOUT_MS = 30000
const FINISHED = new Set(['completed', 'partial'])
const STOPPED = new Set(['failed', 'cancelled', 'canceled', 'expired'])
// Fields every row carries. A list column with one of these names is renamed so it cannot overwrite them.
const RESERVED = new Set(['list_id', 'list_link', 'position', 'source_url', 'checked_at'])

export const desc = `Find a list of real things on the live web and return every matching row, each with the page it was read from. Use it when the answer is many things that meet conditions: companies in a city, local businesses with a service, open grants, tenders, clinical trials, repositories, people in a role. For one fact or a summary of one page, use a search tool instead. Rows that could not be confirmed are left out and are not charged. Returns JSON with status, list_id, list_link and rows (one object per match: its columns, source_url and checked_at). Status "over_maximum" means nothing ran because the price was above the cap. Status "needs_edit" means the request was too vague to price: add the place or what every row must meet.`

export interface SpecStreamListOptions {
    apiKey: string
    maxResults: number
    maxPriceUsd: number
    /** Replaces the hour in the idempotency key, so the same list is never bought twice under one run key. */
    runKey?: string
    waitSeconds?: number
    locale?: string
    /** Replaces the secure fetch, for tests. */
    fetchImpl?: SecureFetch
    /** Replaces the wait between polls, for tests. */
    sleep?: (ms: number) => Promise<void>
    now?: () => number
}

export interface SpecStreamRow {
    list_id: string
    position: number | null
    source_url: string
    checked_at: string
    list_link: string
    [column: string]: unknown
}

export interface SpecStreamResult {
    status: string
    request: string
    message?: string
    list_id?: string
    list_link?: string
    maximum_price_usd?: number
    row_count?: number
    rows?: SpecStreamRow[]
}

interface Cell {
    label?: unknown
    column_id?: unknown
    absence?: unknown
    display?: unknown
    value?: unknown
    provenance?: { source_url?: unknown; observed_at?: unknown } | null
}

interface RawRecord {
    ordinal?: number | null
    details?: Cell[] | null
    cells?: Cell[] | null
}

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value)

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`

export const listLink = (findId: string) => `https://specstream.ai/workspace/collections/${encodeURIComponent(findId)}`

/** One row as flat fields: the list's own columns, then where the row was read. */
export const flattenRow = (findId: string, record: RawRecord): SpecStreamRow => {
    const row: Record<string, unknown> = { list_id: findId, position: record.ordinal ?? null }
    let source: { source_url?: unknown; observed_at?: unknown } | null = null
    const cells = record.details?.length ? record.details : record.cells ?? []
    for (const cell of cells) {
        let label = String(cell.label || cell.column_id || '').trim()
        if (!label) continue
        if (RESERVED.has(label)) label = `${label} (column)`
        let value: unknown
        if (cell.absence) value = ''
        else if (cell.display != null) value = cell.display
        else value = cell.value ?? ''
        row[label] = value
        const provenance = cell.provenance || {}
        if (source === null && String(provenance.source_url || '').startsWith('http')) source = provenance
    }
    row.source_url = source ? source.source_url ?? '' : ''
    row.checked_at = source ? source.observed_at ?? '' : ''
    row.list_link = listLink(findId)
    return row as SpecStreamRow
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

class SpecStreamClient {
    private apiKey: string
    private fetchImpl: SecureFetch
    private sleep: (ms: number) => Promise<void>
    private now: () => number

    constructor(options: Pick<SpecStreamListOptions, 'apiKey' | 'fetchImpl' | 'sleep' | 'now'>) {
        this.apiKey = (options.apiKey ?? '').trim()
        if (!this.apiKey) throw new Error('SpecStream API key not set. Add a SpecStream API credential to this node.')
        this.fetchImpl = options.fetchImpl ?? secureFetch
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
        this.now = options.now ?? Date.now
    }

    private async request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, allow404 = false) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        let response: any
        let raw: string
        try {
            response = await this.fetchImpl(SPECSTREAM_BASE_URL + path, {
                method,
                body: body === undefined ? undefined : JSON.stringify(body),
                headers: {
                    Authorization: /^bearer /i.test(this.apiKey) ? this.apiKey : `Bearer ${this.apiKey}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'flowise-specstream/1.0.0'
                },
                signal: controller.signal
            })
            raw = await response.text()
        } catch (error: any) {
            throw new Error(`Couldn't reach SpecStream: ${error?.message ?? error}`)
        } finally {
            clearTimeout(timer)
        }
        if (!response.ok) {
            if (allow404 && response.status === 404) return null
            let message: string | undefined
            try {
                const detail = JSON.parse(raw || '{}')?.error
                message = isObject(detail) ? detail.message : typeof detail === 'string' ? detail : undefined
            } catch (e) {
                message = undefined
            }
            throw new Error(`SpecStream answered ${response.status}: ${message || response.statusText}`)
        }
        let payload: any
        try {
            payload = JSON.parse(raw || '{}')
        } catch (e) {
            payload = null
        }
        if (!isObject(payload?.data)) throw new Error("SpecStream returned a response this node couldn't read.")
        return payload.data as Record<string, any>
    }

    /** Every row found so far for a list, following the pages. Reading is free. */
    async results(findId: string) {
        const rows: SpecStreamRow[] = []
        let cursor: string | null = null
        let status = 'running'
        for (;;) {
            const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })
            const page: Record<string, any> = (await this.request('GET', `/v1/finds/${encodeURIComponent(findId)}/rows?${query}`)) ?? {}
            status = typeof page.status === 'string' && page.status ? page.status : status
            for (const record of Array.isArray(page.rows) ? (page.rows as RawRecord[]) : []) rows.push(flattenRow(findId, record))
            const next: string | null = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : null
            if (!next || next === cursor) break
            cursor = next
        }
        return { status, rows }
    }

    /** Reads the request, prices it, and runs it only if the most it can cost is within the maximum price. */
    async findList(request: string, options: SpecStreamListOptions): Promise<SpecStreamResult> {
        const q = (request ?? '').trim()
        if (!q) throw new Error('Describe the list to find.')
        const maxResults = Math.trunc(Number(options.maxResults))
        if (!(maxResults >= 1 && maxResults <= MAX_RESULTS)) throw new Error(`Max Results must be from 1 to ${MAX_RESULTS}.`)
        const maxCents = Math.round(Number(options.maxPriceUsd) * 100)
        if (!(maxCents > 0)) throw new Error('Max Price must be greater than 0.')
        const runKey = (options.runKey ?? '').trim()

        // The same request with the same limits gets the run it already started in this hour or the one before,
        // so a retried agent step never buys the list twice, even across the turn of the hour.
        const keyFor = (at: number) => {
            const bucket = runKey ? `run:${runKey}` : new Date(at).toISOString().slice(0, 13)
            return `flowise-${sha256(`${q}|${maxResults}|${maxCents}|${bucket}`).slice(0, 32)}`
        }
        const at = this.now()
        const requestKey = keyFor(at)
        const candidates = runKey ? [requestKey] : [requestKey, keyFor(at - 3600000)]
        let existing: Record<string, any> | null = null
        for (const candidate of candidates) {
            existing = await this.request('GET', `/v1/capacity/requests/${encodeURIComponent(candidate)}`, undefined, true)
            if (existing?.find_id) break
        }

        let findId: string
        let maximumCents: number
        if (existing?.find_id) {
            findId = String(existing.find_id)
            maximumCents = Math.trunc(Number(existing.maximum_cents)) || maxCents
        } else {
            const reading = (await this.request('POST', '/v1/parse', { q, locale: options.locale ?? 'en-US' })) ?? {}
            if (reading.status !== 'runnable') {
                return {
                    status: 'needs_edit',
                    request: q,
                    message: `SpecStream needs a clearer request before it can price it. It read: "${
                        reading.canonical_sentence || q
                    }". Add the place or what every row must meet.`
                }
            }
            const quote =
                (await this.request('POST', '/v1/capacity/quotes', {
                    ast_hash: reading.ast_hash,
                    operation: 'find',
                    requested_units: maxResults
                })) ?? {}
            maximumCents = Math.trunc(Number(quote.maximum_cents)) || 0
            if (maximumCents > maxCents) {
                return {
                    status: 'over_maximum',
                    request: q,
                    maximum_price_usd: maximumCents / 100,
                    message: `Nothing ran: this list can cost up to ${dollars(maximumCents)}, above the maximum of ${dollars(
                        maxCents
                    )}. Ask for fewer results or raise Max Price.`
                }
            }
            const run =
                (await this.request('POST', '/v1/capacity/executions', {
                    quote_id: quote.quote_id,
                    quote_hash: quote.quote_hash,
                    confirm_max_cents: maximumCents,
                    idempotency_key: requestKey
                })) ?? {}
            if (!run.find_id) throw new Error("SpecStream returned a response this node couldn't read.")
            findId = String(run.find_id)
        }

        const waitMs = Math.max(0, options.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000
        const deadline = this.now() + waitMs
        let result = await this.results(findId)
        while (!FINISHED.has(result.status) && !STOPPED.has(result.status) && this.now() < deadline) {
            await this.sleep(POLL_INTERVAL_MS)
            result = await this.results(findId)
        }
        const found: SpecStreamResult = {
            status: result.status,
            request: q,
            list_id: findId,
            list_link: listLink(findId),
            maximum_price_usd: maximumCents / 100,
            row_count: result.rows.length,
            rows: result.rows
        }
        if (!FINISHED.has(result.status) && !STOPPED.has(result.status)) {
            found.message =
                'Still running at the end of the wait. These are the rows found so far; the list keeps running and can be opened at list_link.'
        }
        return found
    }
}

export const findSpecStreamList = (request: string, options: SpecStreamListOptions) =>
    new SpecStreamClient(options).findList(request, options)

export interface SpecStreamToolParameters extends Omit<SpecStreamListOptions, 'fetchImpl' | 'sleep' | 'now'> {
    name?: string
    description?: string
}

const schema = z.object({
    request: z
        .string()
        .min(1)
        .describe(
            'The list in plain words: what to find, where, what every row must meet, and the facts to bring back. Example: "Dental clinics in Lisbon with online booking, with their website and phone".'
        )
})

export class SpecStreamTool extends StructuredTool {
    name: string
    description: string
    // @ts-ignore
    schema = schema
    private params: SpecStreamToolParameters

    constructor(params: SpecStreamToolParameters) {
        super()
        this.params = params
        this.name = params.name || 'specstream_find_list'
        this.description = params.description || desc
    }

    /** The price cap, row count and run key are set on the node, so the model cannot raise them. */
    async _call(arg: z.infer<typeof schema>): Promise<string> {
        try {
            const result = await findSpecStreamList(arg.request, this.params)
            return JSON.stringify(result)
        } catch (error: any) {
            return `SpecStream error: ${error?.message ?? error}`
        }
    }
}
