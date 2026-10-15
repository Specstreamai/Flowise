import { omit } from 'lodash'
import { TextSplitter } from '@langchain/classic/text_splitter'
import { Document, DocumentInterface } from '@langchain/core/documents'
import { BaseDocumentLoader } from '@langchain/classic/document_loaders/base'
import { INode, INodeData, INodeParams, ICommonObject, INodeOutputsValue } from '../../../src/Interface'
import { getCredentialData, getCredentialParam, handleEscapeCharacters } from '../../../src/utils'
import { findSpecStreamList, DEFAULT_WAIT_SECONDS, MAX_RESULTS, SpecStreamRow } from '../../tools/SpecStream/core'

const ROW_FIELDS = ['list_id', 'list_link', 'position', 'source_url', 'checked_at']

interface SpecStreamLoaderParameters {
    apiKey: string
    request: string
    maxResults: number
    maxPriceUsd: number
    runKey?: string
    waitSeconds?: number
}

class SpecStreamLoader extends BaseDocumentLoader {
    constructor(private params: SpecStreamLoaderParameters) {
        super()
    }

    public async load(): Promise<DocumentInterface[]> {
        const result = await findSpecStreamList(this.params.request, this.params)
        if (result.status === 'needs_edit' || result.status === 'over_maximum') {
            throw new Error(`SpecStream: ${result.message}`)
        }
        return (result.rows ?? []).map(
            (row: SpecStreamRow) =>
                new Document({
                    pageContent: Object.entries(row)
                        .filter(([key, value]) => !ROW_FIELDS.includes(key) && value !== '' && value != null)
                        .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
                        .join('\n'),
                    metadata: {
                        source: row.source_url,
                        list_id: row.list_id,
                        list_link: row.list_link,
                        position: row.position,
                        checked_at: row.checked_at
                    }
                })
        )
    }
}

class SpecStream_DocumentLoaders implements INode {
    label: string
    name: string
    description: string
    type: string
    icon: string
    version: number
    category: string
    baseClasses: string[]
    inputs: INodeParams[]
    credential: INodeParams
    outputs: INodeOutputsValue[]

    constructor() {
        this.label = 'SpecStream'
        this.name = 'specStreamDocumentLoaders'
        this.version = 1.0
        this.type = 'Document'
        this.icon = 'specstream.svg'
        this.category = 'Document Loaders'
        this.description = 'Load a list of companies, businesses, people, grants or tenders found on the live web, one Document per row'
        this.baseClasses = [this.type]
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['specStreamApi']
        }
        this.inputs = [
            {
                label: 'Text Splitter',
                name: 'textSplitter',
                type: 'TextSplitter',
                optional: true
            },
            {
                label: 'Request',
                name: 'request',
                type: 'string',
                rows: 3,
                placeholder: 'Dental clinics in Lisbon with online booking, with their website and phone'
            },
            {
                label: 'Max Results',
                name: 'maxResults',
                type: 'number',
                default: 25,
                step: 1,
                description: `How many rows to find, from 1 to ${MAX_RESULTS}. The price grows with the matches.`
            },
            {
                label: 'Max Price (USD)',
                name: 'maxPriceUsd',
                type: 'number',
                default: 5,
                step: 0.5,
                description: 'The most this list may cost. SpecStream quotes the ceiling first; above this price nothing runs.'
            },
            {
                label: 'Run Key',
                name: 'runKey',
                type: 'string',
                optional: true,
                additionalParams: true,
                description:
                    'Optional. A request with the same Run Key never buys its list twice. Leave empty to reuse a list only within the same hour. Change the key to run the list again.'
            },
            {
                label: 'Wait (seconds)',
                name: 'waitSeconds',
                type: 'number',
                default: DEFAULT_WAIT_SECONDS,
                step: 10,
                optional: true,
                additionalParams: true,
                description: 'How long to wait for the list before loading the rows found so far.'
            },
            {
                label: 'Additional Metadata',
                name: 'metadata',
                type: 'json',
                description: 'Additional metadata to be added to the extracted documents',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Omit Metadata Keys',
                name: 'omitMetadataKeys',
                type: 'string',
                rows: 4,
                description:
                    'Each document loader comes with a default set of metadata keys that are extracted from the document. You can use this field to omit some of the default metadata keys. The value should be a list of keys, seperated by comma. Use * to omit all metadata keys execept the ones you specify in the Additional Metadata field',
                placeholder: 'key1, key2, key3.nestedKey1',
                optional: true,
                additionalParams: true
            }
        ]
        this.outputs = [
            {
                label: 'Document',
                name: 'document',
                description: 'Array of document objects containing metadata and pageContent',
                baseClasses: [...this.baseClasses, 'json']
            },
            {
                label: 'Text',
                name: 'text',
                description: 'Concatenated string from pageContent of documents',
                baseClasses: ['string', 'json']
            }
        ]
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const textSplitter = nodeData.inputs?.textSplitter as TextSplitter
        const request = nodeData.inputs?.request as string
        const maxResults = Number(nodeData.inputs?.maxResults)
        const maxPriceUsd = Number(nodeData.inputs?.maxPriceUsd)
        const runKey = nodeData.inputs?.runKey as string
        const waitSeconds = nodeData.inputs?.waitSeconds as string
        const metadata = nodeData.inputs?.metadata
        const _omitMetadataKeys = nodeData.inputs?.omitMetadataKeys as string
        const output = nodeData.outputs?.output as string

        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const apiKey = getCredentialParam('specStreamApiKey', credentialData, nodeData)

        let omitMetadataKeys: string[] = []
        if (_omitMetadataKeys) {
            omitMetadataKeys = _omitMetadataKeys.split(',').map((key) => key.trim())
        }

        const loader = new SpecStreamLoader({
            apiKey,
            request,
            maxResults,
            maxPriceUsd,
            runKey: runKey || undefined,
            waitSeconds: waitSeconds ? Number(waitSeconds) : undefined
        })

        let docs = await loader.load()
        if (textSplitter) docs = await textSplitter.splitDocuments(docs)

        let parsedMetadata: ICommonObject = {}
        if (metadata) {
            parsedMetadata = typeof metadata === 'object' ? metadata : JSON.parse(metadata)
        }

        docs = docs.map((doc) => ({
            ...doc,
            metadata: _omitMetadataKeys === '*' ? { ...parsedMetadata } : omit({ ...doc.metadata, ...parsedMetadata }, omitMetadataKeys)
        }))

        if (output === 'document') {
            return docs
        }
        let finaltext = ''
        for (const doc of docs) {
            finaltext += `${doc.pageContent}\n`
        }
        return handleEscapeCharacters(finaltext, false)
    }
}

module.exports = { nodeClass: SpecStream_DocumentLoaders }
