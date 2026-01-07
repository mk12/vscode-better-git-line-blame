import * as child_process from "child_process";
import * as crypto from "crypto";
import * as pathlib from "path";
import * as readline from "readline";
import * as vscode from "vscode";
import { performance } from "perf_hooks";
import type * as git from "./git";

let extensionContext: vscode.ExtensionContext;
let log: vscode.LogOutputChannel;
let gitApi: git.API;

const cache = new Map<string, Repository>();
const lastDecorationUpdate = new Map<vscode.TextEditor, { line: number, state: CommitStateFull }>();
let lastStatusBarUpdate: vscode.TextEditor | undefined;

interface Repository {
  gitRepo: git.Repository,
  email?: string;
  head: Ref;
  files: Map<string, File>;
  commits: Map<Sha, Commit>;
  host?: Host;
}

interface File {
  state: "loading" | "done" | "dirty";
  tracked: "yes" | "no" | "unknown";
  blame: Ref[]; // refs indexed by 0-based line number
  filenames: Map<Sha, { previous: string, filename: string }>;
  pendingChanges: vscode.TextDocumentContentChangeEvent[];
  pendingEditors: Set<vscode.TextEditor>;
}

type Sha = string;
const uncommitted = Symbol("uncommited");
type Ref = Sha | typeof uncommitted;

interface Commit {
  author: string;
  email: string;
  timestamp: number; // Unix timestamp in seconds
  summary: string;
  message?: CommitMessage; // loaded on demand
}

interface CommitMessage {
  raw: string;
  markdown: string;
}

interface Host {
  kind: "github" | "gitlab";
  path: string;
}

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  context.subscriptions.push(
    log = vscode.window.createOutputChannel("Better Git Line Blame", { log: true })
  );
  const extension = vscode.extensions.getExtension<git.GitExtension>("vscode.git");
  if (!extension) {
    log.appendLine("not in a git repository");
    return;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  const api = exports.getAPI(1);
  const initialize = async () => {
    log.appendLine(`git API initialized with ${api.repositories.length} repo(s)`);
    gitApi = api;
    for (const repo of api.repositories) addRepository(repo);
    context.subscriptions.push(
      api.onDidOpenRepository(addRepository),
      api.onDidCloseRepository(removeRepository),
      vscode.workspace.onDidChangeConfiguration(onDidChangeConfiguration),
      vscode.workspace.onDidOpenTextDocument(onDidOpenTextDocument),
      vscode.workspace.onDidSaveTextDocument(onDidSaveTextDocument),
      vscode.workspace.onDidChangeTextDocument(onDidChangeTextDocument),
      vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor),
      vscode.window.onDidChangeTextEditorSelection(onDidChangeTextEditorSelection),
      vscode.workspace.registerTextDocumentContentProvider("better-git-line-blame-commit", new CommitMessageProvider()),
      vscode.commands.registerCommand("betterGitLineBlame.toggleInlineAnnotations", commandToggleInlineAnnotations),
      vscode.commands.registerCommand("betterGitLineBlame.toggleStatusBarItem", commandToggleStatusBarItem),
      vscode.commands.registerCommand("betterGitLineBlame.showCommit", commandShowCommit),
      vscode.commands.registerCommand("betterGitLineBlame.showCommitPlainText", commandShowCommitPlainText),
      vscode.commands.registerCommand("betterGitLineBlame.showDiff", commandShowDiff),
      vscode.commands.registerCommand("betterGitLineBlame.clearCache", commandClearCache),
      vscode.commands.registerTextEditorCommand("betterGitLineBlame.reblameFile", commandReblameFile),
    );
    updateEditor(vscode.window.activeTextEditor);
    await Promise.all(
      vscode.window.visibleTextEditors.map((editor) => onDidOpenTextDocument(editor.document))
    );
    let numFiles = 0;
    for (const repo of cache.values()) numFiles += repo.files.size;
    log.appendLine(`blamed ${numFiles} initial file(s)`);
    updateEditor(vscode.window.activeTextEditor);
  };
  if (api.state === "initialized") {
    await initialize();
  } else {
    const listener = api.onDidChangeState((state) => {
      listener.dispose();
      if (state === "initialized") initialize();
    });
    context.subscriptions.push(listener);
  }
}

export function deactivate() { cache.clear(); }

class Quota {
  name: string;
  perSecond: number;
  startMs = 0;
  count = 0;
  static failureMessage: string;

  constructor(name: string, perSecond: number) {
    this.name = name;
    this.perSecond = perSecond;
  }

  tick() {
    if (Quota.failureMessage) throw Error(Quota.failureMessage);
    this.count += 1;
    const nowMs = performance.now();
    const elapsedMs = nowMs - this.startMs;
    if (elapsedMs < 1000) return;
    if (this.count > this.perSecond) {
      Quota.failureMessage = `Aborting the Better Git Line Blame extension because ${this.name} was called more than ${this.perSecond} times in 1s. ` +
        `Please file a bug at https://github.com/mk12/vscode-better-git-line-blame/issues/new.`;
      log.appendLine(Quota.failureMessage);
      vscode.window.showErrorMessage(Quota.failureMessage);
      for (const item of extensionContext.subscriptions) if (item !== log) item.dispose();
      throw Error(Quota.failureMessage);
    }
    this.startMs = nowMs;
    this.count = 0;
  }
}

function getConfig() { return vscode.workspace.getConfiguration("betterGitLineBlame"); }

function commandToggleInlineAnnotations() { toggleConfigAndUpdate("showInlineAnnotations"); }
function commandToggleStatusBarItem() { toggleConfigAndUpdate("showStatusBarItem"); }

async function toggleConfigAndUpdate(key: string) {
  const config = getConfig();
  await config.update(key, !config.get(key), vscode.ConfigurationTarget.Global);
  updateEditor(vscode.window.activeTextEditor);
}

function getDecorationType(config: vscode.WorkspaceConfiguration) {
  return getResource(config, "showInlineAnnotations", () => vscode.window.createTextEditorDecorationType({
    isWholeLine: config.get("annotateWholeLine"),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    after: {
      color: new vscode.ThemeColor("betterGitLineBlame.foregroundColor"),
      margin: "0 0 0 3em",
    },
  }));
}

function getStatusBarItem(config: vscode.WorkspaceConfiguration) {
  return getResource(config, "showStatusBarItem", () => {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, config.get("statusBarItemPriority"));
    item.tooltip = "Show Commit Message";
    item.command = {
      title: "Better Git Line Blame: Show Commit Message",
      command: "betterGitLineBlame.showCommit",
    };
    return item;
  });
}

const resources: Record<string, vscode.Disposable> = {};
function getResource<T extends vscode.Disposable>(config: vscode.WorkspaceConfiguration, key: string, create: () => T): T | undefined {
  if (!config.get(key)) {
    deleteResource(key);
    return;
  }
  let resource = resources[key];
  if (resource === undefined) extensionContext.subscriptions.push(resources[key] = resource = create());
  return resource as T;
}

function deleteResource(key: string) {
  resources[key]?.dispose();
  delete resources[key];
}

function onDidChangeConfiguration(event: vscode.ConfigurationChangeEvent) {
  if (event.affectsConfiguration("betterGitLineBlame.annotateWholeLine")) {
    deleteResource("showInlineAnnotations");
    getDecorationType(getConfig());
  }
}

function addRepository(gitRepo: git.Repository): Repository {
  const path = gitRepo.rootUri.fsPath;
  const existing = cache.get(path);
  if (existing) return existing;
  log.appendLine(`adding git repo: ${path}`);
  const repo: Repository = {
    gitRepo,
    head: gitRepo.state.HEAD?.commit ?? uncommitted,
    files: new Map(),
    commits: new Map(),
  };
  cache.set(path, repo);
  const candidates = new Map<string, Host>();
  for (const remote of gitRepo.state.remotes) {
    for (const url of [remote.fetchUrl, remote.pushUrl]) {
      if (!url) continue;
      const host = parseHostFromUrl(url);
      if (host) candidates.set(remote.name, host);
    }
  }
  // Prefer upstream since that's where issues will probably be.
  repo.host = candidates.get("upstream") ?? candidates.get("origin") ?? candidates.values().next().value;
  log.appendLine(`host for repo is ${JSON.stringify(repo.host)}`);
  gitStdout(gitRepo, ["config", "user.email"]).then((output) => repo.email = output.trim());
  return repo;
}

function parseHostFromUrl(url: string): Host | undefined {
  let match;
  if ((match = url.match(/^https:\/\/github\.com\/(.+?\/.+?)(\.git)?$/))) return { kind: "github", path: match[1] };
  if ((match = url.match(/^git@github\.com:(.+?\/.+?)(\.git)?$/))) return { kind: "github", path: match[1] };
  if ((match = url.match(/^https:\/\/gitlab\.com\/(.+?\/.+?)(\.git)?$/))) return { kind: "gitlab", path: match[1] };
  if ((match = url.match(/^git@gitlab\.com:(.+?\/.+?)(\.git)?$/))) return { kind: "gitlab", path: match[1] };
}

function removeRepository(gitRepo: git.Repository) { cache.delete(gitRepo.rootUri.fsPath); }

function commandClearCache() {
  for (const repo of cache.values()) repo.files.clear();
  lastDecorationUpdate.clear();
  lastStatusBarUpdate = undefined;
  updateEditor(vscode.window.activeTextEditor);
}

function commandReblameFile(editor: vscode.TextEditor) {
  const repo = getRepo(editor.document.uri);
  if (!repo) return;
  loadFile(repo, editor, { force: true });
  updateEditor(editor);
}

function onDidOpenTextDocument(document: vscode.TextDocument) {
  const repo = getRepo(document.uri);
  if (repo) loadFile(repo, document);
}

function onDidSaveTextDocument(document: vscode.TextDocument) {
  const repo = getRepo(document.uri);
  if (!repo) return;
  const file = repo.files.get(document.uri.fsPath);
  if (!file) return;
  if (file.tracked === "no") return;
  if (file.state === "dirty" || getConfig().reblameOnSave) loadFile(repo, document, { force: true });
  updateEditor(vscode.window.activeTextEditor, document);
}

const loadFileQuota = new Quota("loadFile", 1000);
function loadFile(repo: Repository, editorOrDocument: vscode.TextEditor | vscode.TextDocument, options?: { force?: boolean, reuse?: File }) {
  loadFileQuota.tick();
  const isEditor = "document" in editorOrDocument;
  const document = isEditor ? editorOrDocument.document : editorOrDocument;
  const path = document.uri.fsPath;
  let file = repo.files.get(path);
  if (file) {
    if (!options?.force || file.state === "loading") return file;
  } else {
    file = { tracked: "unknown" } as File;
  }
  file.state = "loading";
  file.blame = [];
  file.filenames = new Map();
  file.pendingChanges = [];
  file.pendingEditors = new Set();
  if (isEditor) file.pendingEditors.add(editorOrDocument);
  repo.files.set(path, file);
  loadBlameForDocument(repo, file, document);
  return file;
}

function loadBlameForDocument(repo: Repository, file: File, document: vscode.TextDocument) {
  const path = document.uri.fsPath;
  if (!document.isDirty) {
    loadBlameForFile(repo, file, path);
    return;
  }
  file.state = "dirty";
  if (file.tracked !== "unknown") return;
  const proc = gitSpawn(repo.gitRepo, ["ls-files", "--error-unmatch", path]).on("close", (code) => {
    if (code === 0) {
      file.tracked = "yes";
      for (const editor of file.pendingEditors) updateEditor(editor);
    } else if (code === 1) {
      file.tracked = "no";
    } else {
      log.appendLine(`ERROR: ${JSON.stringify(proc.spawnargs)} failed with exit code ${code}`);
    }
  });
}

function onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent) {
  const repo = getRepo(event.document.uri);
  if (!repo) return;
  const document = event.document;
  const file = repo.files.get(document.uri.fsPath);
  if (!file || file.tracked === "no") return;
  switch (file.state) {
    case "loading": file.pendingChanges.push(...event.contentChanges); break;
    case "done": for (const change of event.contentChanges) processChange(file, change); break;
    case "dirty": break;
  }
  // If we added or removed a line, update the editor since it's possible the
  // selection didn't change and onDidChangeTextEditorSelection won't fire.
  if (event.contentChanges.length !== 0) {
    const change = event.contentChanges[0];
    if (!change.range.isSingleLine || change.text.includes("\n"))
      updateEditor(vscode.window.activeTextEditor, document);
  }
}

function processChange(file: File, change: vscode.TextDocumentContentChangeEvent) {
  const start = change.range.start.line;
  const end = change.range.end.line;
  const lines = change.text.split("\n");
  const newEnd = start + lines.length - 1;
  for (let i = start; i <= Math.min(end, newEnd); i++) file.blame[i] = uncommitted;
  if (newEnd < end) file.blame.splice(newEnd + 1, end - newEnd);
  else if (newEnd > end) file.blame.splice(end + 1, 0, ...Array(newEnd - end).fill(uncommitted));
}

function onDidChangeActiveTextEditor(event: vscode.TextEditor | undefined) {
  const statusBarItem = getStatusBarItem(getConfig());
  if (!statusBarItem) return;
  if (event === undefined) statusBarItem.hide();
  else updateEditor(event);
}

function updateEditor(editor?: vscode.TextEditor, document?: vscode.TextDocument) {
  if (!editor) return;
  if (document && editor.document !== document) return;
  onDidChangeTextEditorSelection({ textEditor: editor, selections: editor.selections, kind: undefined }, { force: true });
}

async function onDidChangeTextEditorSelection(event: vscode.TextEditorSelectionChangeEvent, options?: { force?: boolean }) {
  const config = getConfig();
  const decorationType = getDecorationType(config);
  const statusBarItem = getStatusBarItem(config);
  if (!decorationType && !statusBarItem) return;
  const editor = event.textEditor;
  const repo = getRepo(editor.document.uri);
  if (!repo) {
    // Check if it's the active editor, otherwise just having a log window open
    // will cause a selection change every time a log is printed, and come here.
    if (editor === vscode.window.activeTextEditor) {
      lastCommitInfo = undefined;
      if (statusBarItem) {
        if (editor.document.uri.scheme === "file") updateStatusBarItem(statusBarItem, undefined);
        else statusBarItem.hide();
      }
    }
    return;
  }
  const file = loadFile(repo, editor);
  if (file.state === "loading") file.pendingEditors.add(editor);
  const actualHead = repo.gitRepo.state.HEAD?.commit ?? uncommitted;
  if (repo.head !== actualHead) {
    log.appendLine(`${repo.gitRepo.rootUri.fsPath}: detected HEAD change from ${String(repo.head)} to ${String(actualHead)}`);
    lastDecorationUpdate.clear();
    lastStatusBarUpdate = undefined;
    repo.head = actualHead;
    repo.files.clear();
    loadFile(repo, editor, { reuse: file });
  }
  const line = event.selections[0].active.line;
  // Use MAX_VALUE so that it will go on the end of the line even if you type
  // more characters before the decoration gets applied.
  const end = new vscode.Position(line, Number.MAX_VALUE);
  const range = new vscode.Range(end, end);
  const temp = getCommitTemp(editor.document, repo, file, line);
  const lastUpdate = lastDecorationUpdate.get(editor);
  const decorationStale = options?.force || lastCommitInfo === undefined || lastUpdate === undefined || lastUpdate.line !== line || lastUpdate.state !== temp.state;
  const statusBarStale = decorationStale || lastStatusBarUpdate !== editor;
  const decorationNeedsUpdate = decorationType && decorationStale;
  const statusBarNeedsUpdate = statusBarItem && statusBarStale;
  if (!decorationNeedsUpdate && !statusBarNeedsUpdate) return;
  lastDecorationUpdate.set(editor, { line, state: temp.state });
  lastStatusBarUpdate = editor;
  const info = getCommitInfo(editor.document, repo, file, temp, config);
  lastCommitInfo = info;
  if (decorationNeedsUpdate)
    updateDecorationAsync(editor, range, decorationType, info, config.get("enableHoverMessages") as boolean);
  if (statusBarNeedsUpdate)
    updateStatusBarItem(statusBarItem, info);
}

let decorationUpdateId = 0;
async function updateDecorationAsync(editor: vscode.TextEditor, range: vscode.Range, type: vscode.TextEditorDecorationType, info: CommitInfo, enableHover: boolean) {
  const id = ++decorationUpdateId;
  updateDecoration(editor, range, type, info, enableHover);
  if (info.state === "commit" && info.loadedMessage !== undefined && enableHover) {
    await info.loadedMessage;
    if (decorationUpdateId === id) updateDecoration(editor, range, type, info, enableHover);
  }
}

function updateDecoration(editor: vscode.TextEditor, range: vscode.Range, type: vscode.TextEditorDecorationType, info: CommitInfo, enableHover: boolean) {
  let text;
  switch (info.state) {
    case "untracked": editor.setDecorations(type, []); return;
    case "uncommitted": text = "You • Uncommitted changes"; break;
    case "dirty": text = "(Save to blame)"; break;
    case "loading": text = "Loading blame…"; break;
    case "failed": text = "(Failed to blame)"; break;
    case "commit": text = `${info.who}, ${info.when} • ${info.summary}`; break;
  }
  const hoverMessage = enableHover ? buildHoverMessage(info) : undefined;
  editor.setDecorations(type, [{ range, renderOptions: { after: { contentText: text } }, hoverMessage }]);
}

function updateStatusBarItem(item: vscode.StatusBarItem, info?: CommitInfo) {
  let text;
  switch (info?.state) {
    case undefined: text = "No Repo"; break;
    case "untracked": text = "Untracked"; break;
    case "uncommitted": text = "You, uncommited"; break;
    case "dirty": text = "Save to blame"; break;
    case "loading": text = "Loading"; break;
    case "failed": text = "Failed"; break;
    case "commit": text = `${info.who}, ${info.when}`; break;
  }
  item.text = "$(git-commit) " + text;
  item.show();
}

function commandShowCommit() { showCommitDocument({ rendered: true }); }
function commandShowCommitPlainText() { showCommitDocument({ rendered: false }); }

async function showCommitDocument(options: { rendered: boolean }) {
  const info = getLastCommitInfoFull();
  if (!info) return;
  if (!info.commit.message) {
    let canceled = false;
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Loading commit message...",
      cancellable: true,
    }, (progress, token) => {
      token.onCancellationRequested(() => canceled = true);
      return info.loadedMessage ?? Promise.resolve();
    });
    if (canceled) return;
  }
  const query = options.rendered ? "?md" : "";
  const uri = vscode.Uri.parse(`better-git-line-blame-commit:${info.sha}${query}`, true);
  if (options.rendered) vscode.commands.executeCommand("markdown.showPreviewToSide", uri);
  else vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), vscode.ViewColumn.Beside);
}

async function commandShowDiff(args?: { sha: Sha, beforePath: string, afterPath: string }) {
  args ??= getLastCommitInfoFull();
  if (!args) return;

  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) return;

  const gitRepo = gitApi.getRepository(activeEditor.document.uri);
  if (!gitRepo) return;

  // Have to use path with slashes even on Windows because we are talking about
  // a file in git's history. The file might not exist on disk and that's fine.
  const repoRoot = gitRepo.rootUri.fsPath;
  const relativePath = args.beforePath.startsWith(repoRoot)
    ? args.beforePath.slice(repoRoot.length + 1).replace(/\\/g, "/")
    : args.beforePath;
  const beforeSha = args.sha + "~";
  const fileExisted = await fileExistsAtCommit(gitRepo, beforeSha, relativePath);
  if (!fileExisted) {
    vscode.window.showInformationMessage("The file did not exist in the previous commit");
    return;
  }

  const beforeUri = gitUri(beforeSha, args.beforePath);
  const afterUri = gitUri(args.sha, args.afterPath);
  vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri);
}

function getLastCommitInfoFull(): CommitInfoFull | undefined {
  if (lastCommitInfo === undefined) {
    vscode.window.showErrorMessage("This file is not in an open git repository");
    return;
  }
  switch (lastCommitInfo.state) {
    case "untracked": vscode.window.showInformationMessage("This file is not tracked by git"); break;
    case "uncommitted": vscode.window.showInformationMessage("The current line has uncommitted changes"); break;
    case "dirty": vscode.window.showErrorMessage("Please save the file and try again"); break;
    case "loading": vscode.window.showErrorMessage("The blame is still loading"); break;
    case "failed": vscode.window.showErrorMessage("Failed to blame the file"); break;
    case "commit": return lastCommitInfo;
  }
}

let lastCommitInfo: CommitInfo | undefined;
class CommitMessageProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
    const info = lastCommitInfo;
    if (info === undefined) return `Cannot load commit message for ${uri.path}: not found`;
    if (info.state !== "commit") return `Cannot load commit message for ${uri.path}: state is ${info.state}`;
    if (uri.path !== info.sha) return `Cannot load commit message for ${uri.path}: SHA mismatch`;
    const commit = info.commit;
    if (uri.query === "md") {
      return `\
**Commit:** ${info.sha}\\
**Author:** ${commit.author} &lt;${commit.email}&gt;\\
**Date:** ${isoDateAndTime(commit.timestamp)}

${commit.message?.markdown}`;
    }
    return `\
Commit: ${info.sha}
Author: ${commit.author} <${commit.email}>
Date: ${isoDateAndTime(commit.timestamp)}

${commit.message?.raw}`;
  }
}

type CommitState = "untracked" | "uncommitted" | "dirty" | "loading" | "failed";
type CommitStateFull = CommitState | "commit";

type CommitTemp = { state: CommitState } | CommitTempFull;
interface CommitTempFull {
  state: "commit",
  sha: Sha,
  commit: Commit,
}

type CommitInfo = { state: CommitState } | CommitInfoFull;
interface CommitInfoFull {
  state: "commit",
  who: string,
  when: string,
  summary: string,
  sha: Sha,
  commit: Commit,
  beforePath: string,
  afterPath: string,
  loadedMessage?: Promise<void>,
}

function getCommitTemp(document: vscode.TextDocument, repo: Repository, file: File, line: number): CommitTemp {
  if (file.tracked !== "yes") return { state: "untracked" };
  if (file.state === "dirty") return { state: "dirty" };
  const ref = file.blame[line];
  if (ref === undefined) return { state: line === document.lineCount - 1 ? "uncommitted" : "loading" };
  if (ref === uncommitted) return { state: "uncommitted" };
  const commit = repo.commits.get(ref);
  if (commit === undefined) return { state: "failed" };
  return { state: "commit", sha: ref, commit };
}

function getCommitInfo(document: vscode.TextDocument, repo: Repository, file: File, temp: CommitTemp, config: vscode.WorkspaceConfiguration): CommitInfo {
  if (temp.state !== "commit") return temp;
  const { sha, commit } = temp;
  const path = document.uri.fsPath;
  let beforePath = path, afterPath = path;
  const names = file.filenames.get(sha);
  if (names) {
    const prefix = repo.gitRepo.rootUri.fsPath + pathlib.sep;
    beforePath = prefix + names.previous;
    afterPath = prefix + names.filename;
  }
  const maxSummaryLength = config.get("maxSummaryLength") as number;
  const info: CommitInfo = {
    state: "commit",
    commit,
    sha,
    who: commit.email === repo.email ? "You" : commit.author,
    when: friendlyTimestamp(commit.timestamp),
    summary: truncateEllipsis(commit.summary, maxSummaryLength === 0 ? Infinity : maxSummaryLength),
    beforePath,
    afterPath,
  };
  if (commit.message === undefined) {
    info.loadedMessage = (async () => {
      const raw = (await gitStdout(repo.gitRepo, ["show", "-s", "--format=%B", sha])).trimEnd();
      commit.message = { raw, markdown: markdownifyCommitMessage(raw, repo.host) };
    })();
  }
  return info;
}

function markdownifyCommitMessage(raw: string, host: Host | undefined) {
  // This extension renders commit messages as Markdown so that it can use bold,
  // italic, links, etc. If the messages happen to be intentionally written in
  // Markdown, great! But it should look fine even if they're not. Either way,
  // we just need to add hard line breaks, and autolink issues/PRs.
  if (!/^```|(?:\r?\n){2}(?:\t| {4})\S/m.test(raw))
    return autolinkIssuesAndPrs(raw.replace(/\r?\n/g, "  \n"), host);
  // Slow path when there are code blocks (whether intended as such or not).
  let result = "";
  let mode = "normal";
  let prevBlank = true;
  for (let line of raw.split("\n")) {
    line = line.trimEnd(); // deal with carriage returns
    switch (mode) {
      case "indented":
        if (/^\t| {4}/.test(line)) break;
        mode = "normal";
      // fallthrough
      case "normal":
        if (line.startsWith("```")) {
          // VS Code uses the current file's language for highlighting code
          // blocks in hovers by default (assuming e.g. they're docs). This is a
          // bad choice for commit messages so force plain text instead. Note
          // that the problem remains for indented code blocks.
          if (line === "```") line = "```text";
          mode = "fenced";
        }
        else if (prevBlank && /^\t| {4}/.test(line)) mode = "indented";
        else if (line !== "") line = autolinkIssuesAndPrs(line, host) + "  ";
        break;
      case "fenced":
        if (line === "```") mode = "normal";
        break;
    }
    result += line + "\n";
    prevBlank = line === "";
  }
  return result;
}

function autolinkIssuesAndPrs(text: string, host: Host | undefined) {
  switch (host?.kind) {
    case "github":
      // GitHub issues and PRs both use the hash sign (#).
      // Just linking to /issues is fine because it will redirect if it's a PR.
      text = text.replace(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g, `[$1#$2](https://github.com/$1/issues/$2)`);
      text = text.replace(/(\B#|\bGH-)(\d+)\b/g, `[$1$2](https://github.com/${host.path}/issues/$2)`);
      break;
    case "gitlab":
      text = text.replace(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g, `[$1#$2](https://gitlab.com/$1/-/issues/$2)`);
      text = text.replace(/(\B#|\bGL-)(\d+)\b/g, `[$1$2](https://gitlab.com/${host.path}/-/issues/$2)`);
      text = text.replace(/\B!(\d+)\b/g, `[!$1](https://gitlab.com/${host.path}/-/merge_requests/$1)`);
      break;
  }
  return text;
}

function getGravatarUrl(email: string, size = 32): string {
  const hash = crypto.createHash("md5").update(email.trim().toLowerCase()).digest("hex");
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=mp`;
}

function buildHoverMessage(info: CommitInfo) {
  if (info.state !== "commit") return [];
  const commit = info.commit;
  // Prevent automatic mailto link.
  const email = commit.email.replace("@", "&#64;");
  const date = isoDate(commit.timestamp);
  const message = commit.message?.markdown ?? "_Commit message loading..._";
  const avatarUrl = getGravatarUrl(commit.email, 32);
  const mainPart = new vscode.MarkdownString(
    `![avatar](${avatarUrl}) **${commit.author}** &lt;${email}&gt;, ${info.when} (${date})\n\n${message}`
  );
  const query = encodeURIComponent(JSON.stringify({
    sha: info.sha,
    beforePath: info.beforePath,
    afterPath: info.afterPath,
  }));
  const command = vscode.Uri.from({ scheme: "command", path: "betterGitLineBlame.showDiff", query });
  const diffPart = new vscode.MarkdownString(`[Show diff](${command}): ${info.sha}`);
  diffPart.isTrusted = true;
  return [mainPart, diffPart];
}

function gitUri(ref: Sha, path: string) {
  return gitApi.toGitUri(vscode.Uri.file(path), ref)
}

function getRepo(uri: vscode.Uri) {
  if (!gitApi) return;
  if (uri.scheme !== "file") return;
  const gitRepo = gitApi.getRepository(uri);
  if (!gitRepo) return;
  return addRepository(gitRepo);
}

async function loadBlameForFile(repo: Repository, file: File, path: string) {
  log.appendLine(`loading blame: ${path}`);
  const flags = ["--incremental"];
  if (getConfig().ignoreWhitespaceChanges) flags.push("-w");
  const proc = gitSpawn(repo.gitRepo, ["blame", ...flags, "--", path]);
  const exitCode = new Promise(resolve => proc.on("close", resolve));
  const prefix = repo.gitRepo.rootUri.fsPath + pathlib.sep;
  if (!path.startsWith(prefix)) return log.appendLine(`ERROR: path ${path} does not start with ${prefix}`);
  const relPath = path.slice(prefix.length);
  let expectSha = true;
  let sha: Sha | undefined;
  let commit = undefined;
  for await (const line of readline.createInterface({ input: proc.stdout })) {
    if (expectSha) {
      expectSha = false;
      const words = line.split(" ");
      sha = words[0];
      const ref = sha === "0000000000000000000000000000000000000000" ? uncommitted : sha;
      const start = parseInt(words[2]) - 1;
      const num = parseInt(words[3]);
      for (let i = start; i < start + num; i++) file.blame[i] = ref;
      if (ref !== uncommitted && !repo.commits.has(sha))
        commit = {} as Commit;
      else
        commit = undefined;
      if (file.tracked !== "yes") {
        file.tracked = "yes";
        for (const editor of file.pendingEditors) updateEditor(editor);
      }
      continue;
    }
    const idx = line.indexOf(" ");
    const tag = line.substring(0, idx);
    // Every entry is terminated by the filename.
    if (tag === "filename") {
      if (sha !== undefined && commit !== undefined) repo.commits.set(sha, commit);
      expectSha = true;
    }
    if (!commit) continue;
    const content = line.substring(idx + 1);
    switch (tag) {
      case "author":
        if (!commit.author) commit.author = content;
        break;
      case "author-mail":
        commit.email = content.replace(/[<>]/g, "");
        break;
      case "author-time":
        commit.timestamp = parseInt(content);
        break;
      case "summary":
        commit.summary = content.trim();
        break;
      case "previous":
      case "filename": {
        const value = pathlib.normalize(content.substring(content.indexOf(" ") + 1));
        if (value === relPath) break;
        if (sha === undefined) return log.appendLine(`ERROR: sha not set`);
        const names = file.filenames.get(sha);
        if (!names) file.filenames.set(sha, { previous: value, filename: value });
        else names[tag] = value;
        break;
      }
    }
  }
  const code = await exitCode;
  if (code === 0) file.tracked = "yes";
  else if (code === 128) file.tracked = "no";
  else log.appendLine(`ERROR: ${JSON.stringify(proc.spawnargs)} failed with exit code ${code}`)
  file.state = "done";
  if (code === 0) for (const change of file.pendingChanges) processChange(file, change);
  file.pendingChanges = [];
  const editors = Array.from(file.pendingEditors);
  file.pendingEditors.clear();
  await Promise.all(editors.map((editor) => updateEditor(editor)));
}

function gitSpawn(repo: git.Repository, args: string[]) {
  return child_process.spawn(gitApi.git.path, ["-C", repo.rootUri.fsPath, ...args]);
}

async function gitStdout(repo: git.Repository, args: string[]) {
  const proc = gitSpawn(repo, args);
  proc.on("close", (code) => {
    if (code !== 0) log.appendLine(`ERROR: ${JSON.stringify(proc.spawnargs)} failed with exit code ${code}`);
  });
  let result = "";
  for await (const data of proc.stdout) result += data;
  return result;
}

async function fileExistsAtCommit(repo: git.Repository, sha: string, relativePath: string): Promise<boolean> {
  const proc = gitSpawn(repo, ["cat-file", "-e", `${sha}:${relativePath}`]);
  return new Promise((resolve) => {
    proc.on("close", (code) => resolve(code === 0));
  });
}

function isoDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString(undefined, { dateStyle: "medium" });
}

function isoDateAndTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString(undefined, { dateStyle: "long", timeStyle: "long" });
}

function friendlyTimestamp(timestamp: number) {
  const s = Math.round(Date.now() / 1000 - timestamp);
  if (s < 30) return "just now";
  const m = s / 60;
  if (m < 1) return Math.round(s) + " seconds ago";
  if (m < 1.5) return "a minute ago";
  const h = m / 60;
  if (h < 1) return Math.round(m) + " minutes ago";
  if (h < 1.5) return "an hour ago";
  const d = h / 24;
  if (d < 1) return Math.round(h) + " hours ago";
  if (d < 1.5) return "a day ago";
  const w = d / 7;
  if (w < 1) return Math.round(d) + " days ago";
  if (w < 1.5) return "a week ago";
  const mm = w / 4.3333333333;
  if (mm < 1) return Math.round(w) + " weeks ago";
  if (mm < 1.5) return "a month ago";
  const y = d / 365.25;
  if (y < 1) return Math.round(mm) + " months ago";
  if (y < 1.5) return "a year ago";
  return Math.round(y) + " years ago";
}

function truncateEllipsis(str: string, maxLen: number) {
  return str.length <= maxLen ? str : str.substring(0, maxLen - 1) + "…";
}
