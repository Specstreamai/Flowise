import { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'
import { getBaseClasses, getCredentialData, getCredentialParam } from '../../../src/utils'
import { SpecStreamTool, DEFAULT_WAIT_SECONDS, MAX_RESULTS, desc } from './core'

class SpecStream_Tools implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'SpecStream'
        this.name = 'specStream'
        this.version = 1.0
        this.type = 'SpecStream'
        this.icon = 'specstream.svg'
        this.category = 'Tools'
        this.description =
            'Find a list of companies, local businesses, people, grants, tenders or repositories on the live web. Returns every matching row with its source page, priced per match'
        this.baseClasses = [this.type, ...getBaseClasses(SpecStreamTool)]
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['specStreamApi']
        }
        this.inputs = [
            {
                label: 'Max Price (USD)',
                name: 'maxPriceUsd',
                type: 'number',
                default: 5,
                step: 0.5,
                description:
                    'The most one list may cost. SpecStream quotes the ceiling before anything runs; above this price nothing runs and nothing is charged. The agent cannot change it.'
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
                label: 'Run Key',
                name: 'runKey',
                type: 'string',
                optional: true,
                additionalParams: true,
                description:
                    'Optional. A request with the same Run Key never buys its list twice, however many hours later it is retried. Leave empty to reuse a list only within the same hour. Change the key to run the list again.'
            },
            {
                label: 'Wait (seconds)',
                name: 'waitSeconds',
                type: 'number',
                default: DEFAULT_WAIT_SECONDS,
                step: 10,
                optional: true,
                additionalParams: true,
                description: 'How long to wait for the list before returning the rows found so far. A list takes up to about five minutes.'
            },
            {
                label: 'Tool Name',
                name: 'toolName',
                type: 'string',
                default: 'specstream_find_list',
                optional: true,
                additionalParams: true,
                description: 'Name of the tool'
            },
            {
                label: 'Description',
                name: 'description',
                type: 'string',
                rows: 4,
                default: desc,
                optional: true,
                additionalParams: true,
                description: 'Describe to LLM when it should use this tool'
            }
        ]
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const maxPriceUsd = Number(nodeData.inputs?.maxPriceUsd)
        const maxResults = Number(nodeData.inputs?.maxResults)
        const runKey = nodeData.inputs?.runKey as string
        const waitSeconds = nodeData.inputs?.waitSeconds as string
        const toolName = nodeData.inputs?.toolName as string
        const description = nodeData.inputs?.description as string

        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const apiKey = getCredentialParam('specStreamApiKey', credentialData, nodeData)

        return new SpecStreamTool({
            apiKey,
            maxPriceUsd,
            maxResults,
            runKey: runKey || undefined,
            waitSeconds: waitSeconds ? Number(waitSeconds) : undefined,
            name: toolName
                ? toolName
                      .toLowerCase()
                      .replace(/ /g, '_')
                      .replace(/[^a-z0-9_-]/g, '')
                : undefined,
            description: description || undefined
        })
    }
}

module.exports = { nodeClass: SpecStream_Tools }
