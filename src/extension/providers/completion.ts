import {
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionList,
  Position,
  Range,
  TextDocument,
  workspace,
  StatusBarItem,
  window,
  Uri,
  InlineCompletionContext,
  InlineCompletionTriggerKind
} from 'vscode'
import AsyncLock from 'async-lock'
import 'string_score'
import { getFimDataFromProvider, getPrefixSuffix } from '../utils'
import { cache } from '../cache'
import { supportedLanguages } from '../../common/languages'
import {
  PrefixSuffix,
  ResolvedInlineCompletion,
  StreamRequestOptions,
  StreamResponse
} from '../../common/types'
import { getFimPrompt, getStopWords } from '../fim-templates'
import {
  LINE_BREAK_REGEX,
  MAX_CONTEXT_LINE_COUNT
} from '../../common/constants'
import { streamResponse } from '../stream'
import { createStreamRequestBody } from '../model-options'
import { Logger } from '../../common/logger'
import { CompletionFormatter } from '../completion-formatter'
import { FileInteractionCache } from '../file-interaction'

export class CompletionProvider implements InlineCompletionItemProvider {
  private _config = workspace.getConfiguration('twinny')
  private _abortController: AbortController | null
  private _apiHostname = this._config.get('apiHostname') as string
  private _apiPath = this._config.get('fimApiPath') as string
  private _apiProvider = this._config.get('apiProvider') as string
  private _bearerToken = this._config.get('apiBearerToken') as string
  private _cacheEnabled = this._config.get('enableCompletionCache') as boolean
  private _chunkCount = 0
  private _completion = ''
  private _debouncer: NodeJS.Timeout | undefined
  private _debounceWait = this._config.get('debounceWait') as number
  private _disableAuto = this._config.get('disableAutoSuggest') as boolean
  private _document: TextDocument | null
  private _enabled = this._config.get('enabled')
  private _fileInteractionCache: FileInteractionCache
  private _fimModel = this._config.get('fimModelName') as string
  private _fimTemplateFormat = this._config.get('fimTemplateFormat') as string
  private _keepAlive = this._config.get('keepAlive') as string | number
  private _linesGenerated = 0
  private _lock: AsyncLock
  private _logger: Logger
  private _maxLines = this._config.get('maxLines') as number
  private _nonce = 0
  private _numLineContext = this._config.get('contextLength') as number
  private _numPredictFim = this._config.get('numPredictFim') as number
  private _port = this._config.get('fimApiPort') as number
  private _position: Position | null
  private _statusBar: StatusBarItem
  private _stopWords = getStopWords(this._fimModel, this._fimTemplateFormat)
  private _temperature = this._config.get('temperature') as number
  private _useFileContext = this._config.get('useFileContext') as boolean
  private _useMultiLine = this._config.get('useMultiLineCompletions') as boolean
  private _useTls = this._config.get('useTls') as boolean

  constructor(
    statusBar: StatusBarItem,
    fileInteractionCache: FileInteractionCache
  ) {
    this._abortController = null
    this._document = null
    this._lock = new AsyncLock()
    this._logger = new Logger()
    this._position = null
    this._statusBar = statusBar
    this._fileInteractionCache = fileInteractionCache
  }

  public async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext
  ): Promise<InlineCompletionItem[] | InlineCompletionList | null | undefined> {
    const editor = window.activeTextEditor
    if (this.shouldSkipCompletion(context) || !editor || !this._enabled) return
    this._document = document
    this._position = position
    this._chunkCount = 0
    this._linesGenerated = 0
    this._nonce = this._nonce + 1
    this._statusBar.text = '$(loading~spin)'
    this._statusBar.command = 'twinny.stopGeneration'
    const prefixSuffix = getPrefixSuffix(
      this._numLineContext,
      document,
      position
    )
    const prompt = await this.getPrompt(prefixSuffix)
    const cachedCompletion = cache.getCache(prefixSuffix)

    if (cachedCompletion && this._cacheEnabled) {
      this._completion = cachedCompletion
      return this.triggerInlineCompletion(prefixSuffix)
    }

    if (this._debouncer) clearTimeout(this._debouncer)

    return new Promise<ResolvedInlineCompletion>((resolve, reject) => {
      this._debouncer = setTimeout(() => {
        this._lock.acquire('completion', () => {
          this._completion = ''
          return new Promise(
            (_resolve: (completion: ResolvedInlineCompletion) => void) => {
              const { requestBody, requestOptions } =
                this.buildStreamRequest(prompt)

              try {
                streamResponse({
                  body: requestBody,
                  options: requestOptions,
                  onStart: (controller) => this.onStart(controller),
                  onEnd: () => this.onEnd(prefixSuffix, _resolve),
                  onData: (data) => this.onData(data, prefixSuffix, _resolve),
                  onError: this.onError
                })
              } catch (error) {
                this.onError()
                reject([])
              }
            }
          ).then(resolve, reject)
        })
      }, this._debounceWait)
    })
  }

  private buildStreamRequest(prompt: string) {
    const requestBody = createStreamRequestBody(this._apiProvider, prompt, {
      model: this._fimModel,
      numPredictChat: this._numPredictFim,
      temperature: this._temperature,
      keepAlive: this._keepAlive
    })

    const requestOptions: StreamRequestOptions = {
      hostname: this._apiHostname,
      port: this._port,
      path: this._apiPath,
      protocol: this._useTls ? 'https' : 'http',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._bearerToken}`
      }
    }

    return { requestOptions, requestBody }
  }

  private onData(
    data: StreamResponse | undefined,
    prefixSuffix: PrefixSuffix,
    done: (completion: ResolvedInlineCompletion) => void
  ) {
    try {
      const completionData = getFimDataFromProvider(this._apiProvider, data)
      if (completionData === undefined) return done([])

      this._completion = this._completion + completionData
      this._chunkCount = this._chunkCount + 1

      if (this.getIsSingleLineCompletion(completionData)) {
        this._logger.log(
          `Streaming response end due to line break ${this._nonce} \nCompletion: ${this._completion}`
        )
        this._abortController?.abort()
        return done(this.triggerInlineCompletion(prefixSuffix))
      }

      if (LINE_BREAK_REGEX.exec(completionData)) this._linesGenerated++

      if (this.getMaxLinesReached()) {
        this._logger.log(
          `Streaming response end due to max lines or EOT ${this._nonce} \nCompletion: ${this._completion}`
        )
        this.removeStopWords()
        this._abortController?.abort()
        return done(this.triggerInlineCompletion(prefixSuffix))
      }
    } catch (e) {
      console.error(e)
    }
  }

  private onStart(controller: AbortController) {
    this._abortController = controller
  }

  private onEnd(
    prefixSuffix: PrefixSuffix,
    resolve: (comlpetion: ResolvedInlineCompletion) => void
  ) {
    this._logger.log(
      `Streaming response end due to request end ${this._nonce} \nCompletion: ${this._completion}`
    )
    this.removeStopWords()
    this._abortController?.abort()
    resolve(this.triggerInlineCompletion(prefixSuffix))
  }

  public onError = () => {
    this._abortController?.abort()
    this._statusBar.text = '🤖'
  }

  private getPromptHeader(languageId: string | undefined, uri: Uri) {
    const lang =
      supportedLanguages[languageId as keyof typeof supportedLanguages]

    if (!lang) {
      return ''
    }

    const language = `${lang.syntaxComments?.start || ''} Language: ${
      lang?.langName
    } (${languageId}) ${lang.syntaxComments?.end || ''}`

    const path = `${
      lang.syntaxComments?.start || ''
    } File uri: ${uri.toString()} (${languageId}) ${
      lang.syntaxComments?.end || ''
    }`

    return `\n${language}\n${path}\n`
  }

  private async getFileInteractionContext() {
    const interactions = this._fileInteractionCache.getAll()
    const currentFileName = this._document?.fileName || ''

    const fileChunks: string[] = []
    for (const interaction of interactions) {
      const filePath = interaction.name

      if (filePath.toString().match('.git')) {
        continue
      }

      const uri = Uri.file(filePath)

      if (currentFileName === filePath) continue

      const activeLines = interaction.activeLines

      const document = await workspace.openTextDocument(uri)
      const lineCount = document.lineCount

      if (lineCount > MAX_CONTEXT_LINE_COUNT) {
        const averageLine =
          activeLines.reduce((acc, curr) => acc + curr.line, 0) /
          activeLines.length
        const start = new Position(Math.max(0, Math.ceil(averageLine || 0) - 100), 0)
        const end = new Position(Math.min(lineCount, Math.ceil(averageLine || 0) + 100), 0)
        fileChunks.push(`
// File: ${filePath}
// Content: \n ${document.getText(new Range(start, end))}
        `)
      } else {
        fileChunks.push(`
// File: ${filePath}
// Content: \n ${document.getText()}
        `)
      }
    }

    return fileChunks.join('\n')
  }

  private removeStopWords() {
    this._stopWords.forEach((stopWord) => {
      this._completion = this._completion.split(stopWord).join('')
    })
  }

  private shouldSkipCompletion(context: InlineCompletionContext) {
    return (
      context.triggerKind === InlineCompletionTriggerKind.Automatic &&
      this._disableAuto
    )
  }

  private getContainsStopWord() {
    return this._stopWords.some((stopSequence) =>
      this._completion?.includes(stopSequence)
    )
  }

  private getMaxLinesReached() {
    return this._linesGenerated > this._maxLines || this.getContainsStopWord()
  }

  private getIsSingleLineCompletion(completionString: string) {
    return (
      !this._useMultiLine &&
      this._chunkCount > 1 &&
      LINE_BREAK_REGEX.exec(completionString)
    )
  }

  private async getPrompt(prefixSuffix: PrefixSuffix) {
    if (!this._document || !this._position) return ''

    const language = this._document.languageId
    const interactionContext = await this.getFileInteractionContext()

    const prompt = getFimPrompt(this._fimModel, this._fimTemplateFormat, {
      context: interactionContext || '',
      prefixSuffix,
      header: this.getPromptHeader(language, this._document.uri),
      useFileContext: this._useFileContext,
      language: language
    })

    return prompt
  }

  private triggerInlineCompletion(
    prefixSuffix: PrefixSuffix
  ): InlineCompletionItem[] {
    const editor = window.activeTextEditor

    if (!editor || !this._position) return []

    const insertText = new CompletionFormatter(editor).format(this._completion)

    if (this._cacheEnabled) cache.setCache(prefixSuffix, insertText)

    this._logger.log(
      `\n Inline completion triggered: Formatted completion: ${JSON.stringify(
        insertText
      )}\n`
    )

    this._statusBar.text = '🤖'

    return [
      new InlineCompletionItem(
        insertText,
        new Range(this._position, this._position)
      )
    ]
  }

  public updateConfig() {
    this._apiHostname = this._config.get('apiHostname') as string
    this._apiPath = this._config.get('fimApiPath') as string
    this._apiProvider = this._config.get('apiProvider') as string
    this._bearerToken = this._config.get('apiBearerToken') as string
    this._cacheEnabled = this._config.get('enableCompletionCache') as boolean
    this._config = workspace.getConfiguration('twinny')
    this._debounceWait = this._config.get('debounceWait') as number
    this._disableAuto = this._config.get('disableAutoSuggest') as boolean
    this._fimModel = this._config.get('fimModelName') as string
    this._fimTemplateFormat = this._config.get('fimTemplateFormat') as string
    this._keepAlive = this._config.get('keepAlive') as string | number
    this._maxLines = this._config.get('maxLines') as number
    this._numLineContext = this._config.get('contextLength') as number
    this._numPredictFim = this._config.get('numPredictFim') as number
    this._port = this._config.get('fimApiPort') as number
    this._temperature = this._config.get('temperature') as number
    this._useFileContext = this._config.get('useFileContext') as boolean
    this._useMultiLine = this._config.get('useMultiLineCompletions') as boolean
    this._useTls = this._config.get('useTls') as boolean
    this._logger.updateConfig()
  }
}
