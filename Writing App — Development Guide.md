# Writing App — Development Guide

Nov 22, 2026 · @Maxime Portaz

## Stack at a glance

Build it with **Tauri 2** (Rust core) and a **TypeScript + React** interface, using **Tiptap (ProseMirror)** for the WYSIWYG mode and **CodeMirror 6** for the unformatted mode. One repo then produces macOS, Linux and Android builds; Windows is almost free, and iOS comes from the same repo once you have a Mac and an Apple developer account.

Chapters are plain Markdown files synced through Dropbox, and PDFs come from Typst running inside the app. Every choice below is the one to build; this guide does not weigh alternatives.

| Layer | Choice | Why |
| --- | --- | --- |
| App shell | Tauri 2 | One codebase for desktop and mobile, small binaries, Rust for heavy work |
| UI language | TypeScript + React | Largest ecosystem for editors, panels, drag-and-drop trees |
| WYSIWYG mode | Tiptap on ProseMirror | Decorations for name highlighting, Markdown round-trip, mature mobile input handling |
| Plain mode | CodeMirror 6 | Same decoration model, built for touch devices |
| Storage | One plain Markdown file per chapter; order and notes in project.json | Chapters open and edit in any Markdown app; merge paragraph by paragraph |
| Sync | Dropbox through its official API | Works on all five platforms, uses the user's own storage, no server to run |
| Spelling | Hunspell dictionaries for English, French and Spanish, checked in Rust, plus a project dictionary | Offline, instant, invented names never flagged |
| Grammar | Harper for English (offline); LanguageTool for French and Spanish (opt-in) | Private by default, quality where needed |
| Name detection | Multi-pattern matcher (Aho-Corasick) in the editor | Every name and alias checked on each keystroke in well under a millisecond |
| PDF export | Typst embedded in the Rust core | Preview pages and PDF come from the same layout, offline, on every platform |
| EPUB and Word export | epub-builder and docx-rs crates | Pure Rust, nothing extra to install |

## Requirements and interpretation

Everything is a must-have except Windows and iOS. The table records how each requirement is read in this guide.

| Requirement | Priority | Interpretation used in this guide |
| --- | --- | --- |
| Platforms | Must: macOS, Linux, Android. Nice: Windows, iOS | One repo, no per-platform fork of the UI; Windows and iOS only if they need build config, not code changes |
| Look and feel | Must | Close to Scrivener and novelWriter: binder, editor, inspector |
| Two editing modes | Must | WYSIWYG (formatted, word-processor feel) and unformatted (plain text with light Markdown markers). Same file underneath; switching is instant and lossless |
| Left panel | Must | A binder: parts, chapters, scenes; drag to reorder; word count and status per item; a button to hide and show it |
| Right panel | Must | An inspector with sheets for characters, places, notes, plus user-defined types; a button to hide and show it |
| Formatting bar | Must | As minimal as possible: style, bold, italic, text size, line spacing, left and right margins |
| Name detection | Must | Names and aliases from the sheets are highlighted in the text; clicking one opens its sheet |
| Correction | Must | Spelling first, grammar second; works offline; invented names are never flagged |
| Cloud sync | Must | Reopen a project on any device; two devices can have it open at once; check for changes from other devices before editing; uses the user's own Dropbox |
| Plain chapter files | Must | Each chapter is a plain Markdown file in Dropbox, readable and editable in any Markdown app; the app picks up those outside edits |
| Export | Must | PDF with a live page preview, as in novelWriter; also EPUB, Word and Markdown |

Languages: English, French and Spanish at launch, all three added without new libraries; more languages later as downloadable packs.

## Architecture and project format

The interface never touches files directly: it asks the Rust core through Tauri's IPC, and the core owns the project folder, the index, the language tools and the Typst export engine. That split keeps the UI identical everywhere and confines platform differences to one storage module.

&#91;embedded content: architecture · interface, Rust core, project folder\]

Sheets feed their names to the annotation layer, which marks both editors; everything below the IPC line is the same Rust code on all five platforms.

**Project folder layout**

```text
Dropbox/Apps/YourApp/MyNovel/
  project.json                  binder order, chapter and scene notes, sheet templates, settings
  manuscript/
    Part 1 - Arrival/
      01 The arrival.md         plain Markdown, one chapter per file
      02 The ferryman.md
  sheets/
    characters/Elena Voss.md
    places/Harbor Inn.md
    notes/Magic system.md
  dictionary.txt                project words
  .presence/                    one tiny file per device: which chapter it has open

Kept on each device only:
  snapshots/   last 20 versions per chapter
  .sync/       base copies and revision map
  .cache/      name index and counts (safe to delete)
```

**A chapter file, exactly as stored**

```markdown
# The arrival

Elena reached the Harbor Inn at dusk, *soaked to the bone*.

The ferryman was already waiting at the bar.

***

Morning came grey over the river.
```

Rules every chapter file follows: UTF-8, the chapter title as the first heading, one paragraph per line, scenes separated by `***`, and only formatting Markdown can express (italics, bold, block quotes). Status, point of view, synopsis and scene notes live in project.json, so the file holds nothing but the story. File names carry the chapter number so they sort correctly in any file browser.

- **Stable IDs** without file headers: the app tracks each chapter by its Dropbox file ID, which survives renames and moves, so chapter files carry nothing but the text.
- **Plain files, not a database:** they survive app bugs, diff cleanly in Git, and merge paragraph by paragraph during sync. A database, if ever needed, is only a rebuildable cache.
- **Sheets keep a small YAML header:** typed fields (name, aliases, role) in the YAML header, free notes in the body.

## User interface

The main window follows Scrivener and novelWriter: the binder on the left, the chapter in the middle, the inspector on the right, and one slim bar of controls on top. Each side panel has its own hide button at its end of the bar, so the text can take the whole window in two clicks.

&#91;embedded content: main window wireframe · binder, editor, inspector, formatting bar\]

Names in the text are highlighted (Elena, Harbor Inn) and clicking one opens its sheet in the inspector; the wavy underline is a spelling mark.

| Area | What it holds | Hide or show |
| --- | --- | --- |
| Binder (left) | Project name; parts as folders, chapters as files, scenes under each chapter; then Characters, Places, Notes; Trash at the bottom. Drag to reorder, right-click to add, rename or set a status | Button at the top left, or Ctrl/Cmd+Alt+B |
| Editor (middle) | The open chapter as a centred column of text, title on top, with name highlights and spelling marks | Always shown |
| Inspector (right) | A menu with This chapter (synopsis, status, point of view, names found in it), Characters, Places and Notes; shows the sheet of a clicked name | Button at the top right, or Ctrl/Cmd+Alt+I |
| Formatting bar (top) | The controls in the next section, plus Export | Hidden in focus mode |
| Status bar (bottom) | Word counts for the chapter, the book and today; language; Dropbox sync state and "Open on MacBook" warnings | Hidden in focus mode |

- **Panel behaviour:** drag a panel's edge to resize it. Widths and open or closed state are remembered per device. A hidden panel slides away and the text column re-centres; it reopens instantly where you left it.
- **Focus mode (F11):** hides both panels and both bars. Moving the pointer to the top edge brings the bar back; Esc leaves.
- **Phones (under about 700 px wide):** the editor fills the screen. The same two buttons, or a swipe from the screen edge, slide the binder in from the left and the inspector from the right. A tapped name opens a half-height sheet preview, and the formatting bar docks above the on-screen keyboard.
- **Tablets in landscape:** the desktop layout.
- **Theme:** light and dark, following the system by default.

## Formatting bar

One row of eight controls, nothing more: this is a writing tool, not a word processor. Text styles are saved in the chapter's Markdown; size, spacing and margins only change how the text looks on screen. How the book looks on paper is set in the export window.

| Control | What it does | Saved in |
| --- | --- | --- |
| Style menu | Body text, Heading, Quote, Scene break | Chapter file (Markdown) |
| B and I | Bold and italic | Chapter file (Markdown) |
| A− 16 A+ | Text size on screen, 12 to 28 pt; its menu also picks the writing font (serif, sans or mono) | App settings, per device |
| Line | Line spacing: 1.2, 1.5 or 2.0 | App settings, per device |
| Margins | Left and right margins of the text column: two sliders, with Narrow, Medium and Wide presets | App settings, per device |
| Formatted / Plain | Switches between the WYSIWYG mode and plain Markdown | App settings, per device |
| Export | Opens the export window | Nothing |

- **Shortcuts:** Ctrl/Cmd+B and Ctrl/Cmd+I; Ctrl/Cmd with plus or minus for text size. Typing Markdown (`*word*`, `**word**`, `***`) converts on the fly in Formatted mode.
- **Per device on purpose:** a phone and a large monitor need different sizes and margins, and none of it touches the chapter files.
- **Left out on purpose:** colours, fonts per paragraph, tables, columns, page layout in the editor.

## Editor: WYSIWYG and unformatted modes

Store every chapter as a plain Markdown file and put one editor per mode on top of that same text: Tiptap for WYSIWYG, CodeMirror 6 for unformatted. Switching modes serializes the current text and loads it into the other editor, so nothing is lost and both modes keep the same name highlighting and spelling marks.

- **One source of truth.** A small Markdown subset is enough for fiction: paragraphs, headings, italics, bold, block quotes, scene breaks (`***`). A small schema is what makes the round trip exact, and it keeps chapters readable in any editor: no front matter, one paragraph per line.
- **WYSIWYG mode.** Tiptap with the official `@tiptap/markdown` extension, which parses Markdown into the editor and serializes it back ([Tiptap docs](https://tiptap.dev/docs/editor/markdown)). The extension is still marked beta, so write round-trip tests for every node type from day one.
- **Unformatted mode.** CodeMirror 6 with its Markdown mode: markers stay visible but dimmed, with optional typewriter scrolling and a fixed line width. CodeMirror 6 uses the platform's native editing control, so selection and the on-screen keyboard behave normally on phones.
- **Shared annotation layer.** Name matches and spelling errors are computed once on plain text with character offsets. Each editor turns those ranges into its own decorations, so the detection code exists only once.
- **Cursor kept across the switch.** Map the caret through its plain-text offset when changing mode.
- **Saving.** Autosave about 1 second after typing stops; write to a temporary file, then rename it over the original so a crash never leaves a half-written chapter.

## Character and place detection

Build one multi-pattern matcher (Aho-Corasick) from every name and alias in the sheets, re-run it on each paragraph as it changes, and turn every match into a clickable highlight. With a few hundred names this costs far less than a millisecond per paragraph, so it can run on every keystroke.

**Pipeline**

1. Collect patterns: each sheet's name plus its aliases ("Jean-Luc Picard", "Picard", "Jean-Luc", "the Captain"), each tagged with the sheet's ID and a case rule.
2. Build the matcher; rebuild it whenever a sheet is created, renamed or deleted (a few milliseconds).
3. On each edit, re-scan only the paragraphs that changed.
4. Filter matches: whole words only, longest match wins ("New York City" beats "New York").
5. Hand the ranges to the editor as decorations: one style for characters, another for places.
6. Click or tap opens the sheet in the right panel; the caret is still placed, so writing is not interrupted. On desktop, hovering shows a short summary card.

**Rules that matter in fiction**

- Apostrophes count as word edges, so "Arwen's", "d'Arwen" and "l'Auberge" all match; straight and curly apostrophes are treated alike.
- Text is Unicode-normalized so accented names always match, however they were typed.
- Names are case-sensitive by default, so the character Rose is not confused with a rose; each alias can opt out.
- An alias shared by two sheets (two characters called Marie) gets a dashed highlight, and clicking it offers a choice.
- "Ignore here" on a single occurrence is remembered in project.json by its sentence, so the chapter file stays clean.

**Finding new names automatically**

- Unknown capitalized words that are not at the start of a sentence and appear three or more times go into a "Possible names" list.
- One tap: create character, create place, add to dictionary, or ignore. A new sheet is highlighted everywhere at once.

**Project-wide index**

The Rust core runs the same matching over every chapter with the `aho-corasick` crate on save. That builds each sheet's "Appears in" list and per-chapter counts, kept in a cache file that can always be rebuilt.

## Spelling and grammar

Spelling is checked locally against dictionaries that know every character and place name; grammar is a second, optional layer. Grammarly is not used: its developer SDK was shut down on 10 January 2024 ([TechCrunch](https://techcrunch.com/2023/07/13/grammarly-to-shut-down-the-text-editor-sdk-in-january/)).

**Layer 1: spelling (always on, offline)**

- **Engine:** spellbook, a Rust library that reads standard Hunspell dictionaries (MPL-2.0). Its author notes it works well for English and that dictionaries with complex compounding may work less well, so test French early; the fallback is the original Hunspell library through Rust bindings ([spellbook](https://docs.rs/crate/spellbook/latest)).
- **Dictionaries:** the same Hunspell `.aff`/`.dic` files LibreOffice uses, one per language.
- **Word lists merged at check time:** language dictionary, your personal dictionary (all projects), the project dictionary, and every name and alias from the sheets. Fantasy names are never underlined.
- **Checking:** only changed paragraphs, in Rust, returned as ranges into the shared annotation layer; suggestions on right-click or long-press.
- **Turn off the WebView's built-in checker:** it behaves differently on each platform and cannot learn your names.

**Typing aids** (cheap, high value): each language's typography applied as you type (see the table below), plus a short user-editable list of auto-replacements such as "teh" to "the".

**Language support at launch: English, French, Spanish**

Spelling uses spellbook with one Hunspell dictionary per language, so a new language needs no new library. Grammar uses Harper for English, offline, and an optional LanguageTool connection for French and Spanish.

| Language | Spelling dictionary (offline, bundled) | Grammar offline | Grammar via LanguageTool | Typing aids |
| --- | --- | --- | --- | --- |
| English | en\_US, en\_GB | Harper | Yes | Curly quotes, em dash |
| French | fr\_FR, fr\_BE, fr\_CA, fr\_CH; MPL-2.0 | None | Yes | Non-breaking space before `; : ! ?`, `« »` |
| Spanish | [RLA-ES](https://github.com/sbosio/rla-es): Spain and Latin American variants; GPL-3.0, LGPL-3.0 or MPL-1.1, your choice | None | Yes | Dialogue dash `—`, `« »` |

- **Language per project:** language and variant (en-GB, fr-CA, es-MX) live in `project.json`; a scene can override it later for mixed-language books.
- **Bundle the three dictionaries** (a few MB together); later languages arrive as downloadable packs, so the Android app stays small.
- **LanguageTool, three ways to connect,** all off by default:
  - Your own server, for example Docker on a PC or NAS: about 1 GB of memory for one language, up to 4 GB for several ([Railway guide](https://railway.com/deploy/languagetool)).
  - The free public API: 20 requests and 75 KB of text per minute, 20 KB per request, no automated requests, and a visible link back to languagetool.org ([rules](https://dev.languagetool.org/public-http-api)). Enough for an on-demand "Check this chapter", not for checking while typing.
  - A Premium API key for heavier use, 80 requests per minute ([limits](https://help.languagetool.org/hc/en-us/articles/39254488835095)).
- **Send only what changed:** paragraphs go out after a short pause, and results are cached by paragraph content, so an unchanged chapter is never re-sent.

**Later: all languages**

Adding a language is a dictionary pack plus a language code, with no code change. Hunspell dictionaries exist for dozens of languages, each under its own license and some GPL, so check each one ([collection](https://github.com/wooorm/dictionaries)); LanguageTool covers 25+. Two families need real work: right-to-left scripts (Arabic, Hebrew) need editor support, and languages written without spaces (Chinese, Japanese, Thai) need word segmentation before spelling and name detection can work.

## Platforms

macOS, Linux and Android all build from the same Tauri repo with no platform-specific UI code. Windows needs only an extra CI job, so include it from the first release. iOS needs no code changes either, but it needs a Mac with Xcode and a paid Apple Developer membership, so defer it.

| Platform | Priority | Web engine used | Package | What to watch |
| --- | --- | --- | --- | --- |
| macOS | Must | WKWebView (Safari engine) | `.app` / `.dmg` | Signing and notarization for public distribution; unsigned is fine for personal use |
| Linux | Must | WebKitGTK | AppImage, `.deb`, `.rpm`; Flatpak later | The quirkiest engine of the five: test the editor here every week |
| Android | Must | Android System WebView (Chromium) | APK / AAB | On-screen keyboard input and file access, see Risks |
| Windows | Nice, include | WebView2 (Chromium) | `.msi` or `.exe` installer | Nothing beyond a CI runner |
| iOS | Nice, defer | WKWebView | Xcode project generated into `src-tauri/gen/apple` | Adds a generated folder, no app code; needs macOS, Xcode and an Apple Developer account |

**Keeping one repo honest**

- The UI only branches on screen width and touch versus mouse, never on the operating system.
- Anything OS-specific (mainly sign-in and file access on Android) sits in the Rust core behind one storage interface.
- CI builds all targets on every merge, so a platform breakage shows up the same day.

**Moving work between computer and phone**

Version 1 syncs through Dropbox from inside the app (see Cloud sync), so no folder-sync tool is needed. Each device keeps its own local copy in app storage, which also sidesteps Android's folder permissions; `tauri-plugin-android-fs` stays available for importing or exporting a folder through Android's file picker ([docs](https://docs.rs/crate/tauri-plugin-android-fs/latest)).

## Cloud sync

Sync goes through the official Dropbox API, built into the app: no Dropbox app needs to be installed, and it works the same on all five platforms. The app uses the user's own account, so you run no server and the user pays nothing extra.

**What you see in Dropbox:** each project is a normal folder in Dropbox/Apps/YourApp/. Chapters are plain Markdown files you can open and edit from any computer or phone with any Markdown editor that reaches your Dropbox; the app treats those outside edits like edits from another device.

| Topic | How it works with Dropbox |
| --- | --- |
| What the app can see | Only its own folder, Apps/YourApp, never the rest of the Dropbox ([developer guide](https://www.dropbox.com/developers/reference/developer-guide)) |
| Save that cannot overwrite | Upload in "update" mode with the last-known revision; if the file changed meanwhile, Dropbox refuses with a conflict error ([Dropbox answer](https://dropboxforum.com/discussions/101000042/handling-of-local-and-remote-rev-differences/397757)) |
| Change detection | `list_folder/continue` with a cursor returns everything changed since the last check; long-polling gives near-instant notice |
| Renamed files | A file keeps the same ID when renamed or moved, so the app never loses track of a chapter ([Dropbox answer](https://www.dropboxforum.com/t5/Dropbox-API-Support-Feedback/How-to-detect-Dropbox-folder-is-renamed-via-Dropbox-http-api-or/m-p/729703)) |
| Opening to other users | Starts in development status; production approval is needed once 50 users have linked |

**Signing in**

The user signs in on Dropbox's own page, never inside the app, so the app never sees the password. It uses OAuth with PKCE, which needs no secret shipped in the app, and asks for offline access to receive a refresh token that does not expire on its own ([Dropbox](https://dropbox.tech/developers/using-oauth-2-0-with-offline-access)).

1. The user taps **Connect Dropbox**.
2. Dropbox's page opens and asks to give the app access to its own folder. The user signs in if needed (two-factor and password managers work as usual) and taps **Allow**.
3. Dropbox hands a one-time code back to the app.
4. The app swaps the code for a short-lived access token and a long-lived refresh token.
5. The refresh token goes into the system's secure storage; from then on the app renews access silently.
6. The app lists the projects in Apps/YourApp: open one, or create a new one. On a second device, the same steps download the project.

|  | Desktop (macOS, Linux, Windows) | Android |
| --- | --- | --- |
| Where Dropbox's page opens | The default web browser | The Dropbox app if installed, otherwise a browser tab, through Dropbox's official Android SDK (`Auth.startOAuth2PKCE`) |
| How the code comes back | To a temporary local web address the app listens on, via `tauri-plugin-oauth` ([plugin](https://docs.rs/crate/tauri-plugin-oauth/2.0.0/source/README.md)) | Through the `db-<APP_KEY>://` link caught by the SDK's sign-in activity ([SDK overview](https://deepwiki.com/dropbox/dropbox-sdk-java/3.1-sdk-architecture)) |
| Where the token is kept | macOS Keychain, Windows Credential Manager, Linux Secret Service | Android's encrypted app storage |
| Glue code | Rust only | A small Kotlin plugin wrapping the SDK |

- **Desktop detail:** Dropbox only accepts return addresses registered in advance, port included. Register two or three fixed local ports; if all are busy, Dropbox can show the code on its page for the user to paste into the app ([Dropbox answer](https://www.dropboxforum.com/discussions/101000014/redirect-uri-with-variable-loopback-port/197621)).
- **Permissions asked:** read and write files in the app's own folder, plus the account name to show "Connected as Maxime".
- **Staying signed in:** the refresh token works until the user signs out or removes the app in Dropbox's settings.
- **Signing out** revokes the token and asks whether to keep the local copy. If access is revoked from Dropbox's side, the app keeps all local work and asks to reconnect.
- **Linux without a keyring service:** the app falls back to an encrypted file and says so.

**How a save stays safe**

&#91;embedded content: save and sync flow · 2 checks, merge, conflict copy\]

The check at the top answers your "was this file changed elsewhere before I start" rule; the guarded upload at the bottom catches the rare edit made between two checks.

**Details that make it work**

- **A local copy on every device.** Writing never waits for the network, and offline works. On Android the copy lives in app storage, which also removes the folder-permission problem.
- **When it checks:** on opening a project or chapter, on the first keystroke in a chapter, when the window regains focus, and every 30 seconds. Each check is one small "what changed since last time" request.
- **Base copies:** the app keeps the last synced version of each file, so a merge knows what you changed and what the other side changed.
- **Merging:** each paragraph is one line of Markdown, so edits to different paragraphs merge automatically. Edits to the same paragraph keep both versions, and a side-by-side view lets you pick per paragraph. Nothing is ever discarded.
- **Edits made outside the app** (a Markdown editor on your phone, a text editor on another computer) arrive like edits from another device and go through the same merge. A new .md file dropped into manuscript/ shows up as a new chapter.
- **Presence badges:** each device writes a tiny file naming the chapter it has open, refreshed every minute; other devices show "Open on MacBook" on that chapter. Each device writes only its own file, so these never conflict, and they expire after 3 minutes of silence.
- **Binder order:** project.json stores each item's parent and position, and the app renumbers chapter file names to match. Deletions go to Trash everywhere.
- **Offline:** changes queue up and go out on reconnect, through the same guarded uploads.

## Export

One export window: settings on the left, a live preview of the real pages on the right. It follows novelWriter's Manuscript Build tool, whose PDF is made from the same document as its preview ([novelWriter docs](https://vkbo.github.io/novelWriter.io/docs/project_manuscript.html)). Here Typst, a typesetting engine embedded in the Rust core, draws both the preview pages and the PDF, so what you see is exactly what you get, on every platform including Android.

&#91;embedded content: export window wireframe · settings, live page preview\]

Changing any setting on the left redraws the pages on the right; Export PDF writes those same pages to a file.

**Settings**

| Group | Settings |
| --- | --- |
| Format | PDF, EPUB, Word (.docx) or Markdown, as tabs; page settings apply to PDF only |
| Preset | Named sets of settings kept in project.json, so they sync: Paperback A5, Standard manuscript (12 pt, double-spaced, for agents and publishers), Reading copy |
| Content | Whole book or chosen parts and chapters; part and chapter titles; scene-break symbol |
| Page | Size (A5, 6 × 9 in, A4, US Letter); margins, mirrored for print |
| Text | Font and size; line spacing; first-line indent; justified text with hyphenation in the book's language |
| Chapters | Start on a new page or a right-hand page; heading pattern such as "Chapter 1" plus the title |
| Extras | Title page, table of contents, page numbers, running heads |

**How it works**

1. The Rust core turns the selected chapters' Markdown into a Typst document; the settings become Typst parameters.
2. Typst lays out the pages, and the core sends each page to the window as an SVG image for the preview.
3. Any change re-runs the layout in the background and swaps in the new pages as they are ready.
4. Export PDF writes the same layout as a PDF with the fonts embedded. On Android the file goes through the system's save or share sheet.

- **Library:** `typst-as-lib` runs the Typst compiler inside an app; the same document gives PDF, SVG or PNG output ([typst-bake docs](https://docs.rs/crate/typst-bake/0.1.11)).
- **Fonts:** bundle a few open-licence book fonts so a PDF looks the same from every device.
- **Preview controls:** spread or single page, fit or zoom, jump to a chapter.
- **Other formats:** EPUB with the `epub-builder` crate, Word with `docx-rs`, Markdown as one joined file. They use the Content and Chapters settings and ignore page layout.

## Development plan

Eight phases, about 17 to 24 weeks of full-time work for one developer; after phase 3 (roughly 8 to 12 weeks) you can already write a whole book in the app. Each phase ends with something usable, so the plan can stop or change direction at any gate.

&#91;embedded content: development roadmap · 7 phases, 3 gates\]

Phase 0 is the decision point: if typing on Android is unreliable in the WYSIWYG editor, phones use the plain mode while desktops keep both, and the rest of the plan is unchanged.

**Phase 0 checklist**

- [ ] Create the Tauri 2 + React + TypeScript project and build it on macOS, Linux and an Android phone
- [ ] Type a full page in Tiptap and in CodeMirror on two phones with Gboard and one other keyboard, including autocorrect and word suggestions
- [ ] Load the English, French and Spanish Hunspell dictionaries in spellbook and check a 5,000-word sample of your own writing
- [ ] Run the Markdown round trip on a sample chapter and compare the files byte for byte
- [ ] Sign in to Dropbox from a desktop build and the Android build, and make one guarded upload from each
- [ ] Set up CI that builds macOS, Linux, Android and Windows on every merge
- [ ] Render one chapter to preview pages and to a PDF with Typst, on desktop and on Android

## Risks and mitigations

The biggest risk is typing on Android: web editors depend on the phone keyboard's composition events, and Gboard, Samsung Keyboard and others each behave differently. That is why phase 0 is a throwaway prototype on real phones before anything else is built.

| Risk | What goes wrong | Mitigation |
| --- | --- | --- |
| Android keyboard input | Lost characters, jumping caret, broken autocorrect in the WYSIWYG editor | Phase 0 prototype on two real phones and two keyboards; ProseMirror has dedicated Android input handling; CodeMirror mode as the phone fallback |
| Linux web engine | Slower rendering or input quirks in WebKitGTK | Weekly Linux testing, light DOM, one chapter per editor instance |
| Markdown round trip | Formatting lost when switching modes or saving | Small schema, round-trip tests on every node type in CI |
| French and Spanish spelling in spellbook | Valid French or Spanish words flagged | Test both dictionaries in phase 0; fall back to Hunspell bindings |
| Desktop sign-in | The fixed local port Dropbox returns to is already in use | Register two or three ports; fall back to pasting the code Dropbox displays |
| Dropbox approval | New users stop linking two weeks after the 50th without production status | Apply for production status before a public release |
| Sync conflicts | Two devices edit the same chapter | Check before editing, guarded uploads, paragraph merge, both versions kept on overlap |
| Outside edits | A chapter edited in another app breaks the file rules, for example hard line breaks inside a paragraph | Tolerant reader that normalizes on load; never rewrite a file the user has not edited in the app |
| Android file access | Project folder unreachable or permission lost | Local copy in app storage, synced through the Dropbox API; no folder permission needed |
| Long manuscripts | Lag past 150,000 words | Edit one chapter at a time; project-wide work runs in Rust |
| Data loss | Crash or bad save destroys a chapter | Atomic writes, automatic snapshots, keep the last 20 versions per chapter |
| Scope creep | The app is never usable | Phases 0 to 3 are the usable version; everything else waits |

Sources: [Tauri 2.0 release](https://v2.tauri.app/blog/tauri-20/) · [Tiptap Markdown](https://tiptap.dev/docs/editor/markdown) · [spellbook](https://docs.rs/crate/spellbook/latest) · [Harper](https://writewithharper.com/) · [Grammarly SDK shutdown, TechCrunch](https://techcrunch.com/2023/07/13/grammarly-to-shut-down-the-text-editor-sdk-in-january/) · [LanguageTool HTTP server](https://dev.languagetool.org/http-server) · [LanguageTool public API rules](https://dev.languagetool.org/public-http-api) · [LanguageTool API limits](https://help.languagetool.org/hc/en-us/articles/39254488835095) · [Self-hosting LanguageTool, Railway](https://railway.com/deploy/languagetool) · [Hunspell dictionary collection](https://github.com/wooorm/dictionaries) · [Spanish dictionary RLA-ES](https://github.com/sbosio/rla-es) · [Dropbox developer guide](https://www.dropbox.com/developers/reference/developer-guide) · [Dropbox OAuth with offline access](https://dropbox.tech/developers/using-oauth-2-0-with-offline-access) · [Dropbox fixed redirect ports](https://www.dropboxforum.com/discussions/101000014/redirect-uri-with-variable-loopback-port/197621) · [Dropbox guarded uploads](https://dropboxforum.com/discussions/101000042/handling-of-local-and-remote-rev-differences/397757) · [Dropbox file IDs survive renames](https://www.dropboxforum.com/t5/Dropbox-API-Support-Feedback/How-to-detect-Dropbox-folder-is-renamed-via-Dropbox-http-api-or/m-p/729703) · [Dropbox Android SDK overview](https://deepwiki.com/dropbox/dropbox-sdk-java/3.1-sdk-architecture) · [tauri-plugin-oauth](https://docs.rs/crate/tauri-plugin-oauth/2.0.0/source/README.md) · [tauri-plugin-android-fs](https://docs.rs/crate/tauri-plugin-android-fs/latest) · [novelWriter Manuscript Build tool](https://vkbo.github.io/novelWriter.io/docs/project_manuscript.html) · [Typst as an embedded library, typst-bake](https://docs.rs/crate/typst-bake/0.1.11) · [novelWriter tags and references](https://vkbo.github.io/novelWriter.io/docs/usage/tags_and_references.html)
