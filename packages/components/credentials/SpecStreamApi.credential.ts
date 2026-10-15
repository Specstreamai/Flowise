import { INodeParams, INodeCredential } from '../src/Interface'

class SpecStreamApi implements INodeCredential {
    label: string
    name: string
    version: number
    description: string
    inputs: INodeParams[]

    constructor() {
        this.label = 'SpecStream API'
        this.name = 'specStreamApi'
        this.version = 1.0
        this.description =
            'Create an API key under Agents &amp; API in your <a target="_blank" href="https://specstream.ai/workspace">SpecStream workspace</a>. See the <a target="_blank" href="https://specstream.ai/docs/api">API docs</a>'
        this.inputs = [
            {
                label: 'SpecStream API Key',
                name: 'specStreamApiKey',
                type: 'password'
            }
        ]
    }
}

module.exports = { credClass: SpecStreamApi }
