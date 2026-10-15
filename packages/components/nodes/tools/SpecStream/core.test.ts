import { findSpecStreamList, flattenRow } from './core'

const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, statusText: 'x', text: async () => JSON.stringify({ data }) } as unknown as Response)

describe('SpecStream core', () => {
    it('flattens a row with its source and renames reserved columns', () => {
        const row = flattenRow('fnd_1', {
            ordinal: 1,
            details: [
                { label: 'Name', display: 'Clinica A', provenance: { source_url: 'https://a.example/x', observed_at: '2026-10-01' } },
                { label: 'source_url', value: 'col' }
            ]
        })
        expect(row.Name).toBe('Clinica A')
        expect(row['source_url (column)']).toBe('col')
        expect(row.source_url).toBe('https://a.example/x')
        expect(row.list_link).toBe('https://specstream.ai/workspace/collections/fnd_1')
    })

    it('runs within the maximum, sends one idempotency key and returns rows', async () => {
        const calls: { path: string; body?: any }[] = []
        const fetchImpl = (async (url: string, init: any) => {
            const path = url.replace('https://api.specstream.ai', '')
            calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined })
            if (path.startsWith('/v1/capacity/requests/')) return json({}, 404)
            if (path === '/v1/parse') return json({ status: 'runnable', ast_hash: 'h' })
            if (path === '/v1/capacity/quotes') return json({ maximum_cents: 300, quote_id: 'q', quote_hash: 'qh' })
            if (path === '/v1/capacity/executions') return json({ find_id: 'fnd_1' })
            return json({ status: 'completed', rows: [{ ordinal: 1, details: [{ label: 'Name', display: 'A' }] }], next_cursor: null })
        }) as any
        const result = await findSpecStreamList('clinics in Lisbon', { apiKey: 'k', maxResults: 5, maxPriceUsd: 5, fetchImpl })
        expect(result.status).toBe('completed')
        expect(result.rows).toHaveLength(1)
        const exec = calls.find((c) => c.path === '/v1/capacity/executions')!
        expect(exec.body.confirm_max_cents).toBe(300)
        expect(calls.find((c) => c.path.startsWith('/v1/capacity/requests/'))!.path).toContain(exec.body.idempotency_key)
    })

    it('runs nothing when the quote is above the maximum', async () => {
        const fetchImpl = (async (url: string) => {
            if (url.includes('/v1/capacity/requests/')) return json({}, 404)
            if (url.endsWith('/v1/parse')) return json({ status: 'runnable', ast_hash: 'h' })
            if (url.endsWith('/v1/capacity/quotes')) return json({ maximum_cents: 900 })
            throw new Error('should not run')
        }) as any
        const result = await findSpecStreamList('x', { apiKey: 'k', maxResults: 5, maxPriceUsd: 5, fetchImpl })
        expect(result.status).toBe('over_maximum')
    })
})
