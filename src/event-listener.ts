// @ts-nocheck
import { EditorView } from "@codemirror/view";
import { LRUCache } from "lru-cache";
import { App, TFile } from "obsidian";

import AutoComplete from "./core/autocomplete";
import Context from "./core/autocomplete/context-detection";
import DisabledFileSpecificState from "./core/autocomplete/states/disabled-file-specific-state";
import DisabledInvalidSettingsState from "./core/autocomplete/states/disabled-invalid-settings-state";
import DisabledManualState from "./core/autocomplete/states/disabled-manual-state";
import IdleState from "./core/autocomplete/states/idle-state";
import InitState from "./core/autocomplete/states/init-state";
import PredictingState from "./core/autocomplete/states/predicting-state";
import QueuedState from "./core/autocomplete/states/queued-state";
import State from "./core/autocomplete/states/state";
import SuggestingState from "./core/autocomplete/states/suggesting-state";
import { EventHandler } from "./core/autocomplete/states/types";
import { AutocompleteService } from "./core/autocomplete/types";
import { isMatchBetweenPathAndPatterns } from "./core/autocomplete/utils";
import { DocumentChanges } from "./render-plugin/document-changes-listener";
import { cancelSuggestion, insertSuggestion, updateSuggestion } from "./render-plugin/states";
import StatusBar from "./status-bar";
import { InfioSettings } from './types/settings';
import { checkForErrors } from "./utils/auto-complete";


const FIVE_MINUTES_IN_MS = 1000 * 60 * 5;
const MAX_N_ITEMS_IN_CACHE = 5000;

class EventListener implements EventHandler {
  private view: EditorView | null = null;

  private state: EventHandler = new InitState();
  private statusBar: StatusBar;
  private app: App;
  context: Context = Context.Text;
  autocomplete: AutocompleteService;
  settings: InfioSettings;
  private currentFile: TFile | null = null;
  private suggestionCache = new LRUCache<string, string>({ max: MAX_N_ITEMS_IN_CACHE, ttl: FIVE_MINUTES_IN_MS });

  public static fromSettings(
    settings: InfioSettings,
    statusBar: StatusBar,
    app: App
  ): EventListener {
    const autocomplete = createPredictionService(settings);

    const eventListener = new EventListener(
      settings,
      statusBar,
      app,
      autocomplete
    );

    const settingErrors = checkForErrors(settings);
    if (settings.autocompleteEnabled) {
      eventListener.transitionToIdleState()
    } else if (settingErrors.size > 0) {
      eventListener.transitionToDisabledInvalidSettingsState();
    } else if (!settings.autocompleteEnabled) {
      eventListener.transitionToDisabledManualState();
    }

    return eventListener;
  }

  private constructor(
    settings: InfioSettings,
    statusBar: StatusBar,
    app: App,
    autocomplete: AutocompleteService
  ) {
    this.settings = settings;
    this.statusBar = statusBar;
    this.app = app;
    this.autocomplete = autocomplete;
  }

  public setContext(context: Context): void {
    if (context === this.context) {
      return;
    }
    this.context = context;
    this.updateStatusBarText();
  }

  public isSuggesting(): boolean {
    return this.state instanceof SuggestingState;
  }

  public onViewUpdate(view: EditorView): void {
    this.view = view;
  }

  public handleFileChange(file: TFile): void {
    this.currentFile = file;
    this.state.handleFileChange(file);

  }

  public isCurrentFilePathIgnored(): boolean {
    if (this.currentFile === null) {
      return false;
    }
    const patterns = this.settings.ignoredFilePatterns.split("\n");
    return isMatchBetweenPathAndPatterns(this.currentFile.path, patterns);
  }

  public currentFileContainsIgnoredTag(): boolean {
    if (this.currentFile === null) {
      return false;
    }

    const ignoredTags = this.settings.ignoredTags.toLowerCase().split('\n');

    const metadata = this.app.metadataCache.getFileCache(this.currentFile);
    if (!metadata || !metadata.tags) {
      return false;
    }

    const tags = metadata.tags.map(tag => tag.tag.replace(/#/g, '').toLowerCase());
    return tags.some(tag => ignoredTags.includes(tag));
  }


  insertCurrentSuggestion(suggestion: string): void {
    if (this.view === null) {
      return;
    }
    insertSuggestion(this.view, suggestion);
  }

  cancelSuggestion(): void {
    if (this.view === null) {
      return;
    }
    cancelSuggestion(this.view);
  }

  private transitionTo(state: State): void {
    this.state = state;
    this.updateStatusBarText();
  }

  transitionToDisabledFileSpecificState(): void {
    this.transitionTo(new DisabledFileSpecificState(this));
  }

  transitionToDisabledManualState(): void {
    this.cancelSuggestion();
    this.transitionTo(new DisabledManualState(this));
  }

  transitionToDisabledInvalidSettingsState(): void {
    this.cancelSuggestion();
    this.transitionTo(new DisabledInvalidSettingsState(this));
  }

  transitionToQueuedState(prefix: string, suffix: string): void {
    this.transitionTo(
      QueuedState.createAndStartTimer(
        this,
        prefix,
        suffix
      )
    );
  }

  transitionToPredictingState(prefix: string, suffix: string): void {
    this.transitionTo(PredictingState.createAndStartPredicting(
      this,
      prefix,
      suffix
    )
    );
  }

  transitionToSuggestingState(
    suggestion: string,
    prefix: string,
    suffix: string,
    addToCache = true
  ): void {
    if (this.view === null) {
      return;
    }
    if (suggestion.trim().length === 0) {
      this.transitionToIdleState();
      return;
    }
    if (addToCache) {
      this.addSuggestionToCache(prefix, suffix, suggestion);
    }
    this.transitionTo(new SuggestingState(this, suggestion, prefix, suffix));
    updateSuggestion(this.view, suggestion);
  }

  public transitionToIdleState() {
    const previousState = this.state;

    this.transitionTo(new IdleState(this));

    if (previousState instanceof SuggestingState) {
      this.cancelSuggestion();
    }
  }


  private updateStatusBarText(): void {
    this.statusBar.updateText(this.getStatusBarText());
  }

  getStatusBarText(): string {
    return `autocomplete: ${this.state.getStatusBarText()}`;
  }

  handleSettingChanged(settings: InfioSettings): void {
    this.settings = settings;
    this.autocomplete = createPredictionService(settings);
    if (!this.settings.cacheSuggestions) {
      this.clearSuggestionsCache();
    }

    this.state.handleSettingChanged(settings);
  }

  async handleDocumentChange(
    documentChanges: DocumentChanges
  ): Promise<void> {
    await this.state.handleDocumentChange(documentChanges);
  }

  handleAcceptKeyPressed(): boolean {
    return this.state.handleAcceptKeyPressed();
  }

  handlePartialAcceptKeyPressed(): boolean {
    return this.state.handlePartialAcceptKeyPressed();
  }

  handleCancelKeyPressed(): boolean {
    return this.state.handleCancelKeyPressed();
  }

  handlePredictCommand(prefix: string, suffix: string): void {
    this.state.handlePredictCommand(prefix, suffix);
  }

  handleAcceptCommand(): void {
    this.state.handleAcceptCommand();
  }

  containsTriggerCharacters(
    documentChanges: DocumentChanges
  ): boolean {
    for (const trigger of this.settings.triggers) {
      if (trigger.type === "string" && documentChanges.getPrefix().endsWith(trigger.value)) {
        return true;
      }
      if (trigger.type === "regex" && (RegExp(trigger.value).exec(documentChanges.getPrefix()))) {
        return true;
      }
    }
    return false;
  }

  public isDisabled(): boolean {
    return this.state instanceof DisabledManualState || this.state instanceof DisabledInvalidSettingsState || this.state instanceof DisabledFileSpecificState;
  }

  public isIdle(): boolean {
    return this.state instanceof IdleState;
  }

  public getCachedSuggestionFor(prefix: string, suffix: string): string | undefined {
    return this.suggestionCache.get(this.getCacheKey(prefix, suffix));
  }

  private getCacheKey(prefix: string, suffix: string): string {
    const nCharsToKeepPrefix = prefix.length;
    const nCharsToKeepSuffix = suffix.length;

    return `${prefix.substring(prefix.length - nCharsToKeepPrefix)}<mask/>${suffix.substring(0, nCharsToKeepSuffix)}`
  }

  public clearSuggestionsCache(): void {
    this.suggestionCache.clear();
  }

  public addSuggestionToCache(prefix: string, suffix: string, suggestion: string): void {
    if (!this.settings.cacheSuggestions) {
      return;
    }
    this.suggestionCache.set(this.getCacheKey(prefix, suffix), suggestion);
  }
}

function createPredictionService(settings: InfioSettings) {
  return AutoComplete.fromSettings(settings);
}

export default EventListener;
