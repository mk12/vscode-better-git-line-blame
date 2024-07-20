# Changelog

## Unreleased

- Add quota system to abort the extension if it gets into a runaway loop.

## 0.2.8

- [ChrisJohnsen](https://github.com/ChrisJohnsen) Fixed "Show diff" on Windows ([#6](https://github.com/mk12/vscode-better-git-line-blame/pull/6)).

## 0.2.7

- Fix issue where if you type fast, characters would briefly appear after the annotation.
- Fix issue where the status bar item would flicker on and off if there was a log window open.
- Avoid unnecessarily updating decorations when typing and moving cursor within the same line.

## 0.2.6

- Add configuration `betterGitLineBlame.annotateWholeLine` for opting out of the 0.2.5 change.

## 0.2.5

- Only show hover messages when you hover over the blame annotation, not when you hover anywhere on the line.

## 0.2.4

- Normalize paths in `git blame` output to make "Show Diff" work on Windows.

## 0.2.3

- Use OS-specific path separator so that it works on Windows.

## 0.2.2

- Fix bug where "Show diff" showed the diff of the wrong file.

## 0.2.1

- Fix bug where annotations and status bar item showed email instead of name.

## 0.2.0

- Added the ability to show a status bar item instead (or in addition to) the line annotations.
- Added commands "Show Commit", "Show Diff", "Toggle Inline Annotations" and "Toggle Status Bar Item".
- Added configuration: `betterGitLineBlame.showInlineAnnotations`, `betterGitLineBlame.showStatusBarItem`, and `betterGitLineBlame.statusBarItemPriority`.
- Only blame one line at a time. Originally I thought it was be cool to blame all selected lines at once, but I've changed my mind. I never seem to use it, and when I try it, it's noisy and hard to read because they're not aligned with each other. I would consider implementing a full file blame feature that opens in a side bar.
- Removed the obsolete configuration `betterGitLineBlame.maxBlamedLines`.
- Changed relative timestamps from "yesterday/last week/last month/last year" to "a day/week/month/year ago". This is used between 1 and 1.5 units, and it could be confusing if today is Wednesday but 1.5 days ago was Monday, which is not "yesterday".
- Documented commands in README and added FAQ section.

## 0.1.1

- Updated README and did minor refactors.
- Used `isTrusted: false` on commit message Markdown. Before it was true on the whole commit message, even though it was only needed for the `[Show diff](command:...)` link.

## 0.1.0

- Renamed repository from vscode-git-line-blame to vscode-better-git-line-blame to match the Visual Studio Marketplace extension name.
- Documented configuration options in README.
- Added `betterGitLineBlame.reblameOnSave` configuration (false by default).
- Fixed an issue where "Reblame File" command would not show "Loading blame..." annotations.
- Cut off at exactly `betterGitLineBlame.maxBlamedLines`, not on the first new blame entry past that point.

## 0.0.4

- Added `betterGitLineBlame.ignoreWhitespaceChanges` configuration for `git blame -w` (true by default).

## 0.0.3

- Added `betterGitLineBlame.maxSummaryLength` configuration (50 by default).
- Added `betterGitLineBlame.maxBlamedLines` configuration (100 by default).
- Used `betterGitLineBlame` in all configs, colors, commands, etc. (before some used `better-git-line-blame`).
- Used "Better Git Line Blame:" prefix in all command titles.
- Fixed issue where `onDidChangeTextDocument` threw an error on `[0]` access out of bounds.

## 0.0.2

- Avoided showing "(Save to blame)" for untracked files.
- Made it work when activating the extension after git is already initialized.
- Don't wait for commit messages to load before showing line decorations.
- Render commit message as Markdown, but with hard line breaks intact.
- Made "Show diff" link work when there are renames involved.
- Renamed project from vscode-git-line-blame to vscode-better-git-line-blame.
- Added icon, .vscodeignore, and esbuild bundling.
- Published on the Visual Studio Marketplace.

## 0.0.1

- Initial commit.
