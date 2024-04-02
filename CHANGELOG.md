# Changelog

## Unreleased

- Only blame one line at a time. Originally I thought it was be cool to blame all selected lines at once, but I've changed my mind. I never seem to use it, and when I try it, it's noisy and hard to read because they're not aligned with each other. I would consider implementing a full file blame feature that opens in a side bar.
- Remove the obsolete configuration `betterGitLineBlame.maxBlamedLines`.

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
