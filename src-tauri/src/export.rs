//! Export: the book as a PDF (laid out by Typst, which also draws the
//! preview's pages), an EPUB, a Word document or one Markdown file.
//!
//! The interface sends the book as it is in the editor (parts and chapters
//! in binder order, each chapter's Markdown) with the export settings. The
//! chapters' Markdown is read once into a small model of blocks and runs,
//! which each format writes out.

use std::io::{Cursor, Write};
use std::sync::OnceLock;

use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use typst::diag::{FileError, FileResult, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_layout::PagedDocument;

/* The book, as the interface sends it ------------------------------------------ */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub title: String,
    #[serde(default)]
    pub author: String,
    /// The project language, such as "en-GB" or "fr-CA".
    pub language: String,
    /// Parts and chapters outside parts, in binder order.
    pub sections: Vec<Section>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    /// The part's title; None for chapters outside any part.
    pub part: Option<String>,
    pub chapters: Vec<ChapterText>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterText {
    pub title: String,
    pub markdown: String,
}

/* Formats ---------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Pdf,
    Epub,
    Docx,
    Markdown,
}

impl Format {
    /// The save dialog's filter: a name and the file extension.
    pub fn filter(self) -> (&'static str, &'static str) {
        match self {
            Format::Pdf => ("PDF", "pdf"),
            Format::Epub => ("EPUB", "epub"),
            Format::Docx => ("Word document", "docx"),
            Format::Markdown => ("Markdown", "md"),
        }
    }
}

/// The book written in `format`.
pub fn write(book: &Book, settings: &Settings, format: Format) -> Result<Vec<u8>, String> {
    match format {
        Format::Pdf => pdf(&lay_out(book, settings)?),
        Format::Epub => {
            let (id, modified) = epub_stamp(std::time::SystemTime::now());
            epub(book, settings, &id, &modified)
        }
        Format::Docx => docx(book, settings),
        Format::Markdown => Ok(markdown(book, settings).into_bytes()),
    }
}

/// An EPUB's identifier and its modified date (UTC, as EPUB 3 asks), from the time it is made.
fn epub_stamp(now: std::time::SystemTime) -> (String, String) {
    let elapsed = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let seconds = elapsed.as_secs();
    let (days, rest) = ((seconds / 86_400) as i64, seconds % 86_400);
    // Days since 1970 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    let modified = format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    );
    (format!("urn:writing-tool:{}", elapsed.as_millis()), modified)
}

/* Settings ------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageSize {
    A5,
    /// 6 × 9 inches, the usual trade paperback.
    Trade,
    A4,
    Letter,
}

impl PageSize {
    /// Width and height in millimetres.
    fn mm(self) -> (f64, f64) {
        match self {
            PageSize::A5 => (148.0, 210.0),
            PageSize::Trade => (152.4, 228.6),
            PageSize::A4 => (210.0, 297.0),
            PageSize::Letter => (215.9, 279.4),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChapterStart {
    /// A new page.
    NewPage,
    /// A right-hand page, as printed books do.
    RightPage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChapterHeading {
    /// "Chapter 1", then the title.
    NumberAndTitle,
    Title,
    Number,
}

/// The fonts the app bundles for export; a PDF looks the same from every device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BookFont {
    Libertinus,
    ComputerModern,
}

impl BookFont {
    fn family(self) -> &'static str {
        match self {
            BookFont::Libertinus => "Libertinus Serif",
            BookFont::ComputerModern => "New Computer Modern",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub page_size: PageSize,
    /// Margins in millimetres. Inside and outside swap on left-hand pages when mirrored.
    pub margin_inside: f64,
    pub margin_outside: f64,
    pub margin_top: f64,
    pub margin_bottom: f64,
    pub mirrored: bool,
    pub font: BookFont,
    /// Text size in points.
    pub font_size: f64,
    /// Line spacing, as a multiple of the usual (1.0).
    pub line_spacing: f64,
    pub indent: bool,
    pub justify: bool,
    pub hyphenate: bool,
    pub chapter_start: ChapterStart,
    pub chapter_heading: ChapterHeading,
    pub part_titles: bool,
    pub scene_break: String,
    pub title_page: bool,
    pub contents: bool,
    pub page_numbers: bool,
    pub running_heads: bool,
}

impl Default for Settings {
    /// Paperback A5.
    fn default() -> Self {
        Settings {
            page_size: PageSize::A5,
            margin_inside: 20.0,
            margin_outside: 15.0,
            margin_top: 18.0,
            margin_bottom: 20.0,
            mirrored: true,
            font: BookFont::Libertinus,
            font_size: 11.0,
            line_spacing: 1.0,
            indent: true,
            justify: true,
            hyphenate: true,
            chapter_start: ChapterStart::RightPage,
            chapter_heading: ChapterHeading::NumberAndTitle,
            part_titles: true,
            scene_break: "* * *".into(),
            title_page: true,
            contents: true,
            page_numbers: true,
            running_heads: true,
        }
    }
}

/* The chapters' Markdown, read once ------------------------------------------------ */

#[derive(Debug, Clone, PartialEq)]
pub enum Inline {
    Text(String),
    Italic(Vec<Inline>),
    Bold(Vec<Inline>),
    LineBreak,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Paragraph(Vec<Inline>),
    /// A heading inside a chapter (the chapter's own title is left out).
    Heading(Vec<Inline>),
    Quote(Vec<Block>),
    SceneBreak,
}

/// A chapter's blocks. Its first line, when it is the `# ` title the chapter
/// files start with, is left out: the title comes with the chapter.
pub fn read_chapter(markdown: &str) -> Vec<Block> {
    let mut stack: Vec<Vec<Block>> = vec![Vec::new()];
    let mut inlines: Vec<Vec<Inline>> = Vec::new();
    let mut first_block = true;
    let mut skip_title = false;
    // A list item's marker as typed ("-", "1."), until its text starts: a list item is read as a
    // paragraph starting with it, as when dialogue is written "- Bonjour" with its dash not escaped.
    let mut marker: Option<String> = None;

    for (event, range) in Parser::new(markdown).into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                skip_title = first_block && level == HeadingLevel::H1;
                first_block = false;
                inlines.push(Vec::new());
            }
            Event::End(TagEnd::Heading(_)) => {
                let runs = inlines.pop().unwrap_or_default();
                if !skip_title {
                    push_block(&mut stack, Block::Heading(runs));
                }
                skip_title = false;
            }
            Event::Start(Tag::Paragraph) => {
                first_block = false;
                inlines.push(marker.take().map(|m| vec![Inline::Text(m)]).unwrap_or_default());
            }
            Event::Start(Tag::List(_)) => {
                first_block = false;
                // A list in a list item: the item's text so far is a paragraph of its own, before it.
                if let Some(runs) = inlines.last_mut() {
                    let mut runs = std::mem::take(runs);
                    if let Some(m) = marker.take() {
                        runs.insert(0, Inline::Text(m));
                    }
                    if has_text(&runs) {
                        push_block(&mut stack, Block::Paragraph(runs));
                    }
                }
            }
            Event::Start(Tag::Item) => {
                first_block = false;
                let typed = markdown[range].split_whitespace().next().unwrap_or_default();
                marker = (!typed.is_empty()).then(|| format!("{typed} "));
                inlines.push(Vec::new());
            }
            Event::End(TagEnd::Item) => {
                let mut runs = inlines.pop().unwrap_or_default();
                // A tight list's item has its text right in it, with no paragraph.
                if let Some(m) = marker.take() {
                    if has_text(&runs) {
                        runs.insert(0, Inline::Text(m));
                    }
                }
                if has_text(&runs) {
                    push_block(&mut stack, Block::Paragraph(runs));
                }
            }
            Event::End(TagEnd::Paragraph) => {
                let runs = inlines.pop().unwrap_or_default();
                if !runs.is_empty() {
                    push_block(&mut stack, Block::Paragraph(runs));
                }
            }
            Event::Start(Tag::BlockQuote(_)) => {
                first_block = false;
                stack.push(Vec::new());
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                let quoted = stack.pop().unwrap_or_default();
                push_block(&mut stack, Block::Quote(quoted));
            }
            Event::Start(Tag::Emphasis) | Event::Start(Tag::Strong) => inlines.push(Vec::new()),
            Event::End(TagEnd::Emphasis) => close_run(&mut inlines, Inline::Italic),
            Event::End(TagEnd::Strong) => close_run(&mut inlines, Inline::Bold),
            Event::Rule => {
                first_block = false;
                push_block(&mut stack, Block::SceneBreak);
            }
            Event::Text(text) | Event::Code(text) | Event::InlineHtml(text) | Event::Html(text) => {
                push_text(&mut inlines, &mut stack, &text);
            }
            Event::SoftBreak => push_text(&mut inlines, &mut stack, " "),
            Event::HardBreak => {
                if let Some(runs) = inlines.last_mut() {
                    runs.push(Inline::LineBreak);
                }
            }
            // Links and the rest aren't part of the chapter rules: their text is kept.
            _ => {}
        }
    }
    while stack.len() > 1 {
        let quoted = stack.pop().unwrap_or_default();
        push_block(&mut stack, Block::Quote(quoted));
    }
    stack.pop().unwrap_or_default()
}

/// Whether runs hold any text but spaces.
fn has_text(runs: &[Inline]) -> bool {
    runs.iter().any(|run| match run {
        Inline::Text(text) => !text.trim().is_empty(),
        Inline::Italic(inner) | Inline::Bold(inner) => has_text(inner),
        Inline::LineBreak => false,
    })
}

fn push_block(stack: &mut [Vec<Block>], block: Block) {
    if let Some(blocks) = stack.last_mut() {
        blocks.push(block);
    }
}

fn close_run(inlines: &mut Vec<Vec<Inline>>, wrap: fn(Vec<Inline>) -> Inline) {
    let runs = inlines.pop().unwrap_or_default();
    if let Some(parent) = inlines.last_mut() {
        parent.push(wrap(runs));
    }
}

fn push_text(inlines: &mut [Vec<Inline>], stack: &mut [Vec<Block>], text: &str) {
    match inlines.last_mut() {
        Some(runs) => match runs.last_mut() {
            Some(Inline::Text(last)) => last.push_str(text),
            _ => runs.push(Inline::Text(text.to_string())),
        },
        // Text outside a paragraph (HTML blocks): a paragraph of its own.
        None => {
            let text = text.trim();
            if !text.is_empty() {
                push_block(stack, Block::Paragraph(vec![Inline::Text(text.to_string())]));
            }
        }
    }
}

/* Words of the book's language ----------------------------------------------------- */

struct Words {
    chapter: &'static str,
    part: &'static str,
}

fn words_for(language: &str) -> Words {
    match language_code(language).0.as_str() {
        "fr" => Words { chapter: "Chapitre", part: "Partie" },
        "es" => Words { chapter: "Capítulo", part: "Parte" },
        _ => Words { chapter: "Chapter", part: "Part" },
    }
}

/// The language and region of a project language: ("en", Some("gb")).
fn language_code(language: &str) -> (String, Option<String>) {
    let lower = language.trim().to_ascii_lowercase().replace('_', "-");
    let mut parts = lower.split('-');
    let lang = parts.next().filter(|l| l.len() == 2 || l.len() == 3).unwrap_or("en").to_string();
    let region = parts.next().filter(|r| r.len() == 2).map(str::to_string);
    (lang, region)
}

/* Typst ------------------------------------------------------------------------------ */

/// A Typst string literal holding `text`.
fn typst_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' | '\r' => out.push(' '),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Runs as Typst markup: each text run is a string, so nothing in the
/// writer's text is ever read as Typst syntax.
fn typst_runs(runs: &[Inline], out: &mut String) {
    for run in runs {
        match run {
            Inline::Text(text) => {
                out.push('#');
                out.push_str(&typst_string(text));
            }
            Inline::Italic(inner) => {
                out.push_str("#emph[");
                typst_runs(inner, out);
                out.push(']');
            }
            Inline::Bold(inner) => {
                out.push_str("#strong[");
                typst_runs(inner, out);
                out.push(']');
            }
            Inline::LineBreak => out.push_str("#linebreak()"),
        }
    }
}

fn typst_blocks(blocks: &[Block], out: &mut String) {
    for block in blocks {
        match block {
            Block::Paragraph(runs) => {
                typst_runs(runs, out);
                out.push_str("\n\n");
            }
            Block::Heading(runs) => {
                out.push_str("#subheading[");
                typst_runs(runs, out);
                out.push_str("]\n\n");
            }
            Block::Quote(inner) => {
                out.push_str("#quote(block: true)[\n");
                typst_blocks(inner, out);
                out.push_str("]\n\n");
            }
            Block::SceneBreak => out.push_str("#scene-break()\n\n"),
        }
    }
}

/// The whole book as one Typst document.
pub fn typst_source(book: &Book, settings: &Settings) -> String {
    let (width, height) = settings.page_size.mm();
    let (lang, region) = language_code(&book.language);
    let words = words_for(&book.language);
    let margin = if settings.mirrored {
        format!(
            "(inside: {}mm, outside: {}mm, top: {}mm, bottom: {}mm)",
            settings.margin_inside, settings.margin_outside, settings.margin_top, settings.margin_bottom
        )
    } else {
        format!(
            "(left: {}mm, right: {}mm, top: {}mm, bottom: {}mm)",
            settings.margin_inside, settings.margin_outside, settings.margin_top, settings.margin_bottom
        )
    };
    let leading = 0.65 * settings.line_spacing.clamp(0.8, 3.0);
    let to = match settings.chapter_start {
        ChapterStart::RightPage => "to: \"odd\", ",
        ChapterStart::NewPage => "",
    };
    let title = typst_string(&book.title);
    let author = typst_string(&book.author);

    let mut out = String::new();
    out.push_str(&format!(
        r#"#set document(title: {title}{author_field})
#set text(font: {font}, size: {size}pt, lang: "{lang}"{region}, hyphenate: {hyphenate})
#set par(justify: {justify}, leading: {leading:.3}em, spacing: {spacing:.3}em, first-line-indent: (amount: {indent}, all: false))
#set quote(block: true)
#show quote.where(block: true): it => pad(x: 1.5em, it.body)
#let main-matter = state("main-matter", false)
// A page left blank so the next part or chapter starts on a right-hand page: a section ended on the page before, and one starts on the next.
#let blank(p) = (
  query(<section-end>).any(e => e.location().page() == p - 1)
    and query(heading).any(h => h.location().page() == p + 1)
    and not query(heading).any(h => h.location().page() == p)
)
#let chapter-no = state("chapter-no", 0)
// What the next heading is, "part" or "chapter": a chapter outside any part is a heading of level 1, as a part is, so the
// contents and the PDF's bookmarks don't list it under the part before it.
#let heading-kind = state("heading-kind", "chapter")
#let chapter-title = state("chapter-title", none)
#let scene-break() = align(center, block(above: 1.2em, below: 1.2em, {scene}))
#let subheading(body) = block(above: 1.4em, below: 0.8em, sticky: true, text(weight: "bold", body))
#show heading: set text(hyphenate: false)
#show heading.where(outlined: true): it => context {{
  if heading-kind.get() == "part" {{
    v(30%)
    align(center, block({{
      text(size: 0.9em, tracking: 0.08em, upper({part_word}))
      v(0.6em)
      text(size: 1.8em, weight: "regular", it.body)
    }}))
  }} else {{
    v(14%)
    align(center, block(below: 2.4em, {{
      {chapter_number}
      {chapter_title}
    }}))
  }}
}}
#set page(width: {width}mm, height: {height}mm, margin: {margin},
  header: context {{
    let p = here().page()
    if not {running_heads} or not main-matter.get() {{ return }}
    if query(heading).any(h => h.location().page() == p) {{ return }}
    if blank(p) {{ return }}
    set text(size: 0.85em, style: "italic")
    if calc.even(p) {{ align(center, {title}) }} else {{
      let chapter = chapter-title.get()
      if chapter != none {{ align(center, chapter) }}
    }}
  }},
  footer: context {{
    let p = here().page()
    if not {page_numbers} or not main-matter.get() {{ return }}
    if blank(p) {{ return }}
    if query(<part-start>).any(m => m.location().page() == p) {{ return }}
    align(center, text(size: 0.9em, counter(page).display()))
  }},
)
"#,
        author_field = if book.author.trim().is_empty() { String::new() } else { format!(", author: {author}") },
        font = typst_string(settings.font.family()),
        size = settings.font_size.clamp(6.0, 24.0),
        region = region.map(|r| format!(", region: \"{r}\"")).unwrap_or_default(),
        hyphenate = settings.hyphenate,
        justify = settings.justify,
        spacing = if settings.indent { leading } else { leading + 0.6 },
        indent = if settings.indent { "1.2em" } else { "0em" },
        scene = typst_string(&settings.scene_break),
        part_word = typst_string(words.part),
        chapter_number = match settings.chapter_heading {
            ChapterHeading::Title => String::new(),
            _ => format!(
                "text(size: 0.85em, tracking: 0.08em, upper({} + \" \" + str(chapter-no.get())))\n    v(0.7em)",
                typst_string(words.chapter)
            ),
        },
        chapter_title = match settings.chapter_heading {
            ChapterHeading::Number => String::new(),
            _ => "text(size: 1.6em, it.body)".to_string(),
        },
        running_heads = settings.running_heads,
        page_numbers = settings.page_numbers,
    ));

    // Front matter: the title page and the contents, without page numbers.
    if settings.title_page {
        out.push_str(&format!(
            "#page(header: none, footer: none, align(center + horizon, block({{\n  text(size: 2.2em, {title})\n{}}})))\n",
            if book.author.trim().is_empty() {
                String::new()
            } else {
                format!("  v(1.5em)\n  text(size: 1.2em, {author})\n")
            }
        ));
    }
    if settings.contents {
        out.push_str(&format!("#pagebreak({to}weak: true)\n#outline(depth: 2)\n"));
    }

    let mut number = 0;
    let mut started = false;
    for section in &book.sections {
        if let (Some(part), true) = (&section.part, settings.part_titles) {
            out.push_str(&format!("#pagebreak({to}weak: true)\n"));
            if !started {
                out.push_str("#main-matter.update(true)\n#counter(page).update(1)\n");
                started = true;
            }
            out.push_str(&format!(
                "#heading-kind.update(\"part\")\n#metadata(none) <part-start>\n#heading(level: 1, {})\n#metadata(none) <section-end>\n",
                typst_string(part)
            ));
        }
        for chapter in &section.chapters {
            number += 1;
            out.push_str(&format!("#pagebreak({to}weak: true)\n"));
            if !started {
                out.push_str("#main-matter.update(true)\n#counter(page).update(1)\n");
                started = true;
            }
            // Under its part when the part has a title page, else at the top, as a part is.
            let level = if settings.part_titles && section.part.is_some() { 2 } else { 1 };
            let title = typst_string(&chapter.title);
            out.push_str(&format!(
                "#metadata(none) <chapter-start>\n#chapter-no.update({number})\n#heading-kind.update(\"chapter\")\n#chapter-title.update({title})\n#heading(level: {level}, {title})\n\n"
            ));
            typst_blocks(&read_chapter(&chapter.markdown), &mut out);
            out.push_str("#metadata(none) <section-end>\n\n");
        }
    }
    out
}

/// The fonts bundled for export: Libertinus Serif and New Computer Modern
/// (SIL Open Font License), from typst-assets.
fn fonts() -> &'static (LazyHash<FontBook>, Vec<Font>) {
    static FONTS: OnceLock<(LazyHash<FontBook>, Vec<Font>)> = OnceLock::new();
    FONTS.get_or_init(|| {
        let fonts: Vec<Font> = typst_assets::fonts()
            .flat_map(|data| Font::iter(Bytes::new(data)))
            .filter(|font| {
                let family = &font.info().family;
                family == "Libertinus Serif" || family == "New Computer Modern"
            })
            .collect();
        (LazyHash::new(FontBook::from_fonts(&fonts)), fonts)
    })
}

fn library() -> &'static LazyHash<Library> {
    static LIBRARY: OnceLock<LazyHash<Library>> = OnceLock::new();
    LIBRARY.get_or_init(|| LazyHash::new(Library::default()))
}

/// One compilation: the book's source and nothing else (no files, no packages).
struct BookWorld {
    main: Source,
}

impl World for BookWorld {
    fn library(&self) -> &LazyHash<Library> {
        library()
    }
    fn book(&self) -> &LazyHash<FontBook> {
        &fonts().0
    }
    fn main(&self) -> FileId {
        self.main.id()
    }
    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main.id() { Ok(self.main.clone()) } else { Err(FileError::AccessDenied) }
    }
    fn file(&self, _id: FileId) -> FileResult<Bytes> {
        Err(FileError::AccessDenied)
    }
    fn font(&self, index: usize) -> Option<Font> {
        fonts().1.get(index).cloned()
    }
    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None
    }
}

fn describe(errors: &[SourceDiagnostic]) -> String {
    let messages: Vec<String> = errors.iter().take(3).map(|e| e.message.to_string()).collect();
    format!("The pages could not be laid out: {}", messages.join("; "))
}

/// Lays the book out into pages.
pub fn lay_out(book: &Book, settings: &Settings) -> Result<PagedDocument, String> {
    let id = RootedPath::new(VirtualRoot::Project, VirtualPath::new("/book.typ").map_err(|e| format!("{e:?}"))?).intern();
    let world = BookWorld { main: Source::new(id, typst_source(book, settings)) };
    let document = typst::compile::<PagedDocument>(&world).output.map_err(|errors| describe(&errors));
    // Typst keeps what it worked out, to lay out faster next time, until it is told to forget: what the
    // last few layouts didn't use goes, or each change of the settings would add to it for good.
    typst::comemo::evict(4);
    document
}

/// The page each chapter starts on (from 0), in reading order, for the preview's chapter list.
pub fn chapter_pages(document: &PagedDocument) -> Vec<usize> {
    use typst::foundations::{Label, Selector};
    use typst::introspection::Introspector;
    let Some(label) = Label::new(typst::utils::PicoStr::intern("chapter-start")) else {
        return Vec::new();
    };
    let introspector = document.introspector();
    introspector
        .query(&Selector::Label(label))
        .iter()
        .filter_map(|element| element.location())
        .filter_map(|location| introspector.page(location))
        .map(|page| page.get() - 1)
        .collect()
}

/// The size of the first page in points (all pages share it), or A5's when there are none.
pub fn page_size_pt(document: &PagedDocument) -> (f64, f64) {
    match document.pages().first() {
        Some(page) => {
            let size = page.frame.size();
            (size.x.to_pt(), size.y.to_pt())
        }
        None => (419.53, 595.28),
    }
}

/// One page as an SVG image, for the preview.
pub fn page_svg(document: &PagedDocument, index: usize) -> Option<String> {
    document.pages().get(index).map(|page| typst_svg::svg(page, &typst_svg::SvgOptions::default()))
}

pub fn pdf(document: &PagedDocument) -> Result<Vec<u8>, String> {
    typst_pdf::pdf(document, &typst_pdf::PdfOptions::default()).map_err(|errors| describe(&errors))
}

/* Markdown ---------------------------------------------------------------------------- */

fn markdown_runs(runs: &[Inline], out: &mut String) {
    for run in runs {
        match run {
            Inline::Text(text) => out.push_str(&escape_markdown(text)),
            Inline::Italic(inner) => {
                out.push('*');
                markdown_runs(inner, out);
                out.push('*');
            }
            Inline::Bold(inner) => {
                out.push_str("**");
                markdown_runs(inner, out);
                out.push_str("**");
            }
            Inline::LineBreak => out.push_str("\\\n"),
        }
    }
}

fn escape_markdown(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '*' | '_' | '`' | '[' | ']' | '<' | '#' | '~') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A line of a paragraph, escaped where it would start a list, a quote, a rule or a heading's
/// underline, as the app's own writer does (escapeParagraphStart in src/core/readable.ts).
fn escape_line_start(line: &str) -> String {
    let bytes = line.as_bytes();
    let blank_after = |i: usize| i >= bytes.len() || matches!(bytes[i], b' ' | b'\t');
    let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    let underline = !line.trim().is_empty() && line.chars().all(|c| matches!(c, '-' | '=' | ' ' | '\t'));
    if underline || bytes.first() == Some(&b'>') || (matches!(bytes.first(), Some(b'-' | b'+')) && blank_after(1)) {
        format!("\\{line}")
    } else if (1..=9).contains(&digits) && matches!(bytes.get(digits), Some(b'.' | b')')) && blank_after(digits + 1) {
        format!("{}\\{}", &line[..digits], &line[digits..])
    } else {
        line.to_string()
    }
}

fn markdown_blocks(blocks: &[Block], prefix: &str, heading: &str, out: &mut String) {
    for block in blocks {
        match block {
            Block::Paragraph(runs) => {
                let mut text = String::new();
                markdown_runs(runs, &mut text);
                out.push_str(prefix);
                // Each line: a line break leaves the text on the next line, where it could start a list as well.
                out.push_str(&text.split('\n').map(escape_line_start).collect::<Vec<_>>().join("\n"));
                out.push_str("\n\n");
            }
            Block::Heading(runs) => {
                out.push_str(prefix);
                out.push_str(heading);
                out.push(' ');
                markdown_runs(runs, out);
                out.push_str("\n\n");
            }
            Block::Quote(inner) => {
                let mut quoted = String::new();
                markdown_blocks(inner, "", heading, &mut quoted);
                for line in quoted.trim_end().lines() {
                    out.push_str(prefix);
                    out.push_str(if line.is_empty() { ">" } else { "> " });
                    out.push_str(line);
                    out.push('\n');
                }
                out.push('\n');
            }
            Block::SceneBreak => {
                out.push_str(prefix);
                out.push_str("***\n\n");
            }
        }
    }
}

/// The book as one Markdown file: its title, then parts and chapters as headings.
pub fn markdown(book: &Book, settings: &Settings) -> String {
    let mut out = format!("# {}\n\n", escape_markdown(&book.title));
    if !book.author.trim().is_empty() {
        out.push_str(&format!("{}\n\n", escape_markdown(&book.author)));
    }
    let parts = settings.part_titles && book.sections.iter().any(|s| s.part.is_some());
    for section in &book.sections {
        if let (Some(part), true) = (&section.part, parts) {
            out.push_str(&format!("## {}\n\n", escape_markdown(part)));
        }
        for chapter in &section.chapters {
            // Under its part, or at the top as a part is when it has none.
            let level = if parts && section.part.is_some() { "###" } else { "##" };
            out.push_str(&format!("{level} {}\n\n", escape_markdown(&chapter.title)));
            markdown_blocks(&read_chapter(&chapter.markdown), "", &format!("{level}#"), &mut out);
        }
    }
    format!("{}\n", out.trim_end())
}

/* EPUB --------------------------------------------------------------------------------- */

fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Characters XML can't hold.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            c => out.push(c),
        }
    }
    out
}

fn html_runs(runs: &[Inline], out: &mut String) {
    for run in runs {
        match run {
            Inline::Text(text) => out.push_str(&xml_escape(text)),
            Inline::Italic(inner) => {
                out.push_str("<em>");
                html_runs(inner, out);
                out.push_str("</em>");
            }
            Inline::Bold(inner) => {
                out.push_str("<strong>");
                html_runs(inner, out);
                out.push_str("</strong>");
            }
            Inline::LineBreak => out.push_str("<br/>"),
        }
    }
}

fn html_blocks(blocks: &[Block], scene_break: &str, out: &mut String) {
    let mut after_break = true;
    for block in blocks {
        match block {
            Block::Paragraph(runs) => {
                out.push_str(if after_break { "<p class=\"first\">" } else { "<p>" });
                html_runs(runs, out);
                out.push_str("</p>\n");
                after_break = false;
            }
            Block::Heading(runs) => {
                out.push_str("<h3>");
                html_runs(runs, out);
                out.push_str("</h3>\n");
                after_break = true;
            }
            Block::Quote(inner) => {
                out.push_str("<blockquote>\n");
                html_blocks(inner, scene_break, out);
                out.push_str("</blockquote>\n");
                after_break = true;
            }
            Block::SceneBreak => {
                out.push_str(&format!("<p class=\"scene-break\">{}</p>\n", xml_escape(scene_break)));
                after_break = true;
            }
        }
    }
}

const EPUB_CSS: &str = "body { margin: 0 5%; font-family: serif; line-height: 1.5; }
h1, h2 { text-align: center; font-weight: normal; margin: 3em 0 2em; }
h1 .number, h2 .number { display: block; font-size: 0.6em; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.6em; }
h3 { font-size: 1em; margin: 1.5em 0 0.5em; }
p { margin: 0; text-indent: 1.2em; text-align: justify; }
p.first { text-indent: 0; }
p.scene-break { text-align: center; text-indent: 0; margin: 1em 0; }
blockquote { margin: 1em 1.5em; }
.title-page { text-align: center; margin-top: 30%; }
.title-page h1 { font-size: 2em; margin: 0 0 1em; }
";

fn xhtml(language: &str, title: &str, body: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"{lang}\" lang=\"{lang}\">\n<head>\n<meta charset=\"utf-8\"/>\n<title>{title}</title>\n<link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\"/>\n</head>\n<body>\n{body}</body>\n</html>\n",
        lang = xml_escape(language),
        title = xml_escape(title),
    )
}

/// Where a page is listed in an EPUB's contents.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Nest {
    Top,
    Part,
    InPart,
}

/// The book as an EPUB 3 file: a title page, one page per part and chapter, and the contents.
pub fn epub(book: &Book, settings: &Settings, id: &str, modified: &str) -> Result<Vec<u8>, String> {
    let words = words_for(&book.language);
    let language = book.language.trim().replace('_', "-");
    // (file name, title for the contents, where it is in the contents, body)
    let mut pages: Vec<(String, String, Nest, String)> = Vec::new();
    if settings.title_page {
        let mut body = format!("<section class=\"title-page\" epub:type=\"titlepage\">\n<h1>{}</h1>\n", xml_escape(&book.title));
        if !book.author.trim().is_empty() {
            body.push_str(&format!("<p class=\"first\">{}</p>\n", xml_escape(&book.author)));
        }
        body.push_str("</section>\n");
        pages.push(("title.xhtml".into(), book.title.clone(), Nest::Top, body));
    }
    let mut number = 0;
    for (s, section) in book.sections.iter().enumerate() {
        if let (Some(part), true) = (&section.part, settings.part_titles) {
            let body = format!(
                "<section epub:type=\"part\">\n<h1><span class=\"number\">{}</span>{}</h1>\n</section>\n",
                xml_escape(words.part),
                xml_escape(part)
            );
            pages.push((format!("part-{}.xhtml", s + 1), part.clone(), Nest::Part, body));
        }
        for chapter in &section.chapters {
            number += 1;
            let heading = match settings.chapter_heading {
                ChapterHeading::NumberAndTitle => format!(
                    "<span class=\"number\">{} {number}</span>{}",
                    xml_escape(words.chapter),
                    xml_escape(&chapter.title)
                ),
                ChapterHeading::Title => xml_escape(&chapter.title),
                ChapterHeading::Number => format!("{} {number}", xml_escape(words.chapter)),
            };
            let mut body = format!("<section epub:type=\"chapter\">\n<h2>{heading}</h2>\n");
            html_blocks(&read_chapter(&chapter.markdown), &settings.scene_break, &mut body);
            body.push_str("</section>\n");
            let toc_title = match settings.chapter_heading {
                ChapterHeading::Number => format!("{} {number}", words.chapter),
                _ => chapter.title.clone(),
            };
            let nest = if settings.part_titles && section.part.is_some() { Nest::InPart } else { Nest::Top };
            pages.push((format!("chapter-{number}.xhtml"), toc_title, nest, body));
        }
    }

    // The contents, nested: chapters under their part, and those outside any part at the top.
    let mut nav = String::from("<nav epub:type=\"toc\" id=\"toc\">\n<h1>Contents</h1>\n<ol>\n");
    let mut in_part = false;
    for (file, title, nest, _) in &pages {
        if file == "title.xhtml" {
            continue;
        }
        if *nest != Nest::InPart && in_part {
            nav.push_str("</ol></li>\n");
            in_part = false;
        }
        if *nest == Nest::Part {
            nav.push_str(&format!("<li><a href=\"{file}\">{}</a><ol>\n", xml_escape(title)));
            in_part = true;
        } else {
            nav.push_str(&format!("<li><a href=\"{file}\">{}</a></li>\n", xml_escape(title)));
        }
    }
    if in_part {
        nav.push_str("</ol></li>\n");
    }
    nav.push_str("</ol>\n</nav>\n");

    let mut manifest = String::from(
        "<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n<item id=\"css\" href=\"style.css\" media-type=\"text/css\"/>\n",
    );
    let mut spine = String::new();
    for (i, (file, ..)) in pages.iter().enumerate() {
        manifest.push_str(&format!("<item id=\"p{i}\" href=\"{file}\" media-type=\"application/xhtml+xml\"/>\n"));
        spine.push_str(&format!("<itemref idref=\"p{i}\"/>\n"));
    }
    let creator = if book.author.trim().is_empty() {
        String::new()
    } else {
        format!("<dc:creator>{}</dc:creator>\n", xml_escape(&book.author))
    };
    let opf = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"book-id\" xml:lang=\"{lang}\">\n<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n<dc:identifier id=\"book-id\">{id}</dc:identifier>\n<dc:title>{title}</dc:title>\n{creator}<dc:language>{lang}</dc:language>\n<meta property=\"dcterms:modified\">{modified}</meta>\n</metadata>\n<manifest>\n{manifest}</manifest>\n<spine>\n{spine}</spine>\n</package>\n",
        lang = xml_escape(&language),
        id = xml_escape(id),
        title = xml_escape(&book.title),
        modified = xml_escape(modified),
    );

    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let fail = |e: zip::result::ZipError| format!("The EPUB could not be written: {e}");
    let io = |e: std::io::Error| format!("The EPUB could not be written: {e}");
    // The mimetype comes first, uncompressed, as readers expect.
    zip.start_file("mimetype", stored).map_err(fail)?;
    zip.write_all(b"application/epub+zip").map_err(io)?;
    zip.start_file("META-INF/container.xml", deflated).map_err(fail)?;
    zip.write_all(b"<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">\n<rootfiles>\n<rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/>\n</rootfiles>\n</container>\n").map_err(io)?;
    zip.start_file("OEBPS/content.opf", deflated).map_err(fail)?;
    zip.write_all(opf.as_bytes()).map_err(io)?;
    zip.start_file("OEBPS/style.css", deflated).map_err(fail)?;
    zip.write_all(EPUB_CSS.as_bytes()).map_err(io)?;
    zip.start_file("OEBPS/nav.xhtml", deflated).map_err(fail)?;
    zip.write_all(xhtml(&language, "Contents", &nav).as_bytes()).map_err(io)?;
    for (file, title, _, body) in &pages {
        zip.start_file(format!("OEBPS/{file}"), deflated).map_err(fail)?;
        zip.write_all(xhtml(&language, title, body).as_bytes()).map_err(io)?;
    }
    Ok(zip.finish().map_err(fail)?.into_inner())
}

/* Word ---------------------------------------------------------------------------------- */

fn docx_runs(runs: &[Inline], italic: bool, bold: bool, mut paragraph: docx_rs::Paragraph) -> docx_rs::Paragraph {
    for run in runs {
        paragraph = match run {
            Inline::Text(text) => {
                let mut r = docx_rs::Run::new().add_text(text);
                if italic {
                    r = r.italic();
                }
                if bold {
                    r = r.bold();
                }
                paragraph.add_run(r)
            }
            Inline::Italic(inner) => docx_runs(inner, true, bold, paragraph),
            Inline::Bold(inner) => docx_runs(inner, italic, true, paragraph),
            Inline::LineBreak => paragraph.add_run(docx_rs::Run::new().add_break(docx_rs::BreakType::TextWrapping)),
        };
    }
    paragraph
}

fn docx_blocks(blocks: &[Block], settings: &Settings, quoted: bool, mut docx: docx_rs::Docx) -> docx_rs::Docx {
    let mut first = true;
    for block in blocks {
        docx = match block {
            Block::Paragraph(runs) => {
                let mut p = docx_rs::Paragraph::new().style(if quoted { "Quote" } else if first { "BodyFirst" } else { "Body" });
                p = docx_runs(runs, false, false, p);
                first = false;
                docx.add_paragraph(p)
            }
            Block::Heading(runs) => {
                first = true;
                docx.add_paragraph(docx_runs(runs, false, true, docx_rs::Paragraph::new().style("Heading3")))
            }
            Block::Quote(inner) => {
                first = true;
                docx_blocks(inner, settings, true, docx)
            }
            Block::SceneBreak => {
                first = true;
                docx.add_paragraph(
                    docx_rs::Paragraph::new()
                        .style("SceneBreak")
                        .add_run(docx_rs::Run::new().add_text(&settings.scene_break)),
                )
            }
        };
    }
    docx
}

/// The book as a Word document: styles for body text, headings, quotes and
/// scene breaks, so it can be restyled in Word; each chapter on a new page.
pub fn docx(book: &Book, settings: &Settings) -> Result<Vec<u8>, String> {
    use docx_rs::{AlignmentType, Docx, LineSpacing, Paragraph, Run, RunFonts, Style, StyleType};
    let words = words_for(&book.language);
    let half_points = (settings.font_size * 2.0).round() as usize;
    let line = (240.0 * settings.line_spacing.clamp(0.8, 3.0)).round() as i32;
    let indent = if settings.indent { 340 } else { 0 };
    let after = if settings.indent { 0 } else { 160 };
    let fonts = RunFonts::new().ascii(settings.font.family()).hi_ansi(settings.font.family());
    let align = if settings.justify { AlignmentType::Both } else { AlignmentType::Left };

    let mut docx = Docx::new()
        .default_fonts(fonts.clone())
        .default_size(half_points)
        .add_style(
            Style::new("Body", StyleType::Paragraph)
                .name("Body Text")
                .align(align)
                .line_spacing(LineSpacing::new().line(line).after(after as u32))
                .indent(None, Some(docx_rs::SpecialIndentType::FirstLine(indent)), None, None),
        )
        .add_style(
            Style::new("BodyFirst", StyleType::Paragraph)
                .name("Body Text First")
                .based_on("Body")
                .indent(None, Some(docx_rs::SpecialIndentType::FirstLine(0)), None, None),
        )
        .add_style(
            Style::new("Quote", StyleType::Paragraph)
                .name("Quote")
                .based_on("Body")
                .indent(Some(567), Some(docx_rs::SpecialIndentType::FirstLine(0)), Some(567), None),
        )
        .add_style(
            Style::new("SceneBreak", StyleType::Paragraph)
                .name("Scene Break")
                .align(AlignmentType::Center)
                .line_spacing(LineSpacing::new().before(240).after(240)),
        )
        .add_style(
            Style::new("Title", StyleType::Paragraph)
                .name("Title")
                .align(AlignmentType::Center)
                .size(half_points * 2)
                .line_spacing(LineSpacing::new().before(2400).after(480)),
        )
        .add_style(
            Style::new("Heading1", StyleType::Paragraph)
                .name("Heading 1")
                .outline_lvl(0)
                .align(AlignmentType::Center)
                .size(half_points * 3 / 2)
                .line_spacing(LineSpacing::new().before(2400).after(240)),
        )
        .add_style(
            Style::new("Heading2", StyleType::Paragraph)
                .name("Heading 2")
                .outline_lvl(1)
                .align(AlignmentType::Center)
                .size(half_points * 3 / 2)
                .line_spacing(LineSpacing::new().before(1440).after(720)),
        )
        .add_style(
            Style::new("Heading3", StyleType::Paragraph)
                .name("Heading 3")
                .outline_lvl(2)
                .bold()
                .line_spacing(LineSpacing::new().before(240).after(120)),
        );

    if settings.title_page {
        docx = docx.add_paragraph(Paragraph::new().style("Title").add_run(Run::new().add_text(&book.title)));
        if !book.author.trim().is_empty() {
            docx = docx.add_paragraph(
                Paragraph::new().align(AlignmentType::Center).add_run(Run::new().add_text(&book.author)),
            );
        }
    }
    let mut number = 0;
    let mut first_page = !settings.title_page;
    for section in &book.sections {
        if let (Some(part), true) = (&section.part, settings.part_titles) {
            let mut p = Paragraph::new().style("Heading1");
            if !first_page {
                p = p.page_break_before(true);
            }
            first_page = false;
            docx = docx.add_paragraph(
                p.add_run(Run::new().add_text(format!("{} ", words.part)))
                    .add_run(Run::new().add_break(docx_rs::BreakType::TextWrapping))
                    .add_run(Run::new().add_text(part)),
            );
        }
        for chapter in &section.chapters {
            number += 1;
            // Heading 2 under its part when the part has a title, else Heading 1, as a part is (so Word's
            // navigation and contents don't list it under the part before it), spaced as a chapter.
            let mut p = if settings.part_titles && section.part.is_some() {
                Paragraph::new().style("Heading2")
            } else {
                Paragraph::new().style("Heading1").line_spacing(LineSpacing::new().before(1440).after(720))
            };
            if !first_page {
                p = p.page_break_before(true);
            }
            first_page = false;
            p = match settings.chapter_heading {
                ChapterHeading::NumberAndTitle => p
                    .add_run(Run::new().add_text(format!("{} {number}", words.chapter)))
                    .add_run(Run::new().add_break(docx_rs::BreakType::TextWrapping))
                    .add_run(Run::new().add_text(&chapter.title)),
                ChapterHeading::Title => p.add_run(Run::new().add_text(&chapter.title)),
                ChapterHeading::Number => p.add_run(Run::new().add_text(format!("{} {number}", words.chapter))),
            };
            docx = docx.add_paragraph(p);
            docx = docx_blocks(&read_chapter(&chapter.markdown), settings, false, docx);
        }
    }
    let mut out = Cursor::new(Vec::new());
    docx.build().pack(&mut out).map_err(|e| format!("The Word document could not be written: {e}"))?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Book {
        Book {
            title: "The Ferryman’s Debt".into(),
            author: "Ada \"Quill\" Lane".into(),
            language: "en-GB".into(),
            sections: vec![
                Section {
                    part: Some("Arrival".into()),
                    chapters: vec![ChapterText {
                        title: "The arrival".into(),
                        markdown: "# The arrival\n\nElena reached the Harbor Inn at dusk, *soaked to the bone*.\n\n\"You're late,\" said **Arno** #hash $5 [link] <tag> \\*not\\* = - + / ~ @x // comment\n\n***\n\n> A quote\n> on two lines\n\nMorning.\n".into(),
                    }],
                },
                Section {
                    part: None,
                    chapters: vec![ChapterText { title: "Upstream \"quoted\"".into(), markdown: "# Upstream\n\nThe river.\n".into() }],
                },
            ],
        }
    }

    #[test]
    fn stamps_an_epub_with_the_utc_date() {
        let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_795_612_751);
        assert_eq!(epub_stamp(at).1, "2026-11-25T13:19:11Z");
        assert_eq!(epub_stamp(std::time::UNIX_EPOCH).1, "1970-01-01T00:00:00Z");
    }

    #[test]
    fn writes_every_format() {
        for format in [Format::Pdf, Format::Epub, Format::Docx, Format::Markdown] {
            assert!(!write(&sample(), &Settings::default(), format).unwrap().is_empty());
        }
    }

    #[test]
    fn reads_chapters_into_blocks() {
        let blocks = read_chapter("# Title\n\nOne *two* **three**\nfour\n\n***\n\n> Quoted\n\n## Sub\n");
        assert_eq!(
            blocks,
            vec![
                Block::Paragraph(vec![
                    Inline::Text("One ".into()),
                    Inline::Italic(vec![Inline::Text("two".into())]),
                    Inline::Text(" ".into()),
                    Inline::Bold(vec![Inline::Text("three".into())]),
                    Inline::Text(" four".into()),
                ]),
                Block::SceneBreak,
                Block::Quote(vec![Block::Paragraph(vec![Inline::Text("Quoted".into())])]),
                Block::Heading(vec![Inline::Text("Sub".into())]),
            ]
        );
    }

    #[test]
    fn lays_out_any_text_without_reading_it_as_typst() {
        let document = lay_out(&sample(), &Settings::default()).unwrap();
        assert!(document.pages().len() >= 5, "{}", document.pages().len());
        assert_eq!(chapter_pages(&document).len(), 2);
        let svg = page_svg(&document, 0).unwrap();
        assert!(svg.starts_with("<svg"));
        assert!(pdf(&document).unwrap().starts_with(b"%PDF"));
        for heading in [ChapterHeading::Title, ChapterHeading::Number] {
            for start in [ChapterStart::NewPage, ChapterStart::RightPage] {
                let settings = Settings {
                    chapter_heading: heading,
                    chapter_start: start,
                    indent: false,
                    mirrored: false,
                    title_page: false,
                    contents: false,
                    part_titles: false,
                    ..Settings::default()
                };
                lay_out(&sample(), &settings).unwrap();
            }
        }
    }

    #[test]
    fn reads_list_items_as_paragraphs_with_their_marker() {
        // Dialogue written "- Tu es sûr ?" in Plain, its dash not escaped, reads as a list.
        assert_eq!(
            read_chapter("- Tu es *sûr* ?\n- Non.\n"),
            vec![
                Block::Paragraph(vec![
                    Inline::Text("- ".into()),
                    Inline::Text("Tu es ".into()),
                    Inline::Italic(vec![Inline::Text("sûr".into())]),
                    Inline::Text(" ?".into()),
                ]),
                Block::Paragraph(vec![Inline::Text("- ".into()), Inline::Text("Non.".into())]),
            ]
        );
        let book = |markdown: &str| Book {
            title: "T".into(),
            author: String::new(),
            language: "fr".into(),
            sections: vec![Section { part: None, chapters: vec![ChapterText { title: "C".into(), markdown: markdown.into() }] }],
        };
        let md = markdown(&book("1. Un\n\n2. *Deux*\n\n- a\n  - b\n"), &Settings::default());
        assert!(md.contains("1\\. Un\n\n2\\. *Deux*\n\n\\- a\n\n\\- b\n"), "{md}");
    }

    #[test]
    fn escapes_markdown_that_would_start_a_block() {
        let book = Book {
            title: "T".into(),
            author: String::new(),
            language: "fr".into(),
            sections: vec![Section {
                part: None,
                chapters: vec![ChapterText {
                    title: "C".into(),
                    markdown: "\\- Bonjour\n\n1984\\. It was\n\n\\> Not a quote\n\nA line\\\n\\- dash\\\n\\===\n\nA ~~~ fence\n".into(),
                }],
            }],
        };
        let md = markdown(&book, &Settings::default());
        for written in ["\\- Bonjour\n", "1984\\. It was\n", "\\> Not a quote\n", "A line\\\n\\- dash\\\n\\===\n", "A \\~\\~\\~ fence"] {
            assert!(md.contains(written), "{written:?} in {md}");
        }
        // Read back, it is the same text.
        let again = read_chapter(&md);
        assert!(again.contains(&Block::Paragraph(vec![Inline::Text("- Bonjour".into())])), "{again:?}");
    }

    #[test]
    fn lists_a_chapter_outside_any_part_at_the_top() {
        // sample(): the part Arrival with The arrival, then Upstream, in no part.
        let source = typst_source(&sample(), &Settings::default());
        assert!(source.contains("#heading(level: 2, \"The arrival\")"), "{source}");
        assert!(source.contains("#heading(level: 1, \"Upstream \\\"quoted\\\"\")"), "{source}");
        let flat = typst_source(&sample(), &Settings { part_titles: false, contents: true, ..Settings::default() });
        assert!(flat.contains("#heading(level: 1, \"The arrival\")"));
        assert!(flat.contains("#outline(depth: 2)"));
        let document = lay_out(&sample(), &Settings { part_titles: false, contents: true, ..Settings::default() }).unwrap();
        assert_eq!(chapter_pages(&document).len(), 2);

        let epub = epub(&sample(), &Settings::default(), "urn:uuid:test", "2026-01-01T00:00:00Z").unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(epub)).unwrap();
        let mut nav = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("OEBPS/nav.xhtml").unwrap(), &mut nav).unwrap();
        assert!(
            nav.contains("<li><a href=\"chapter-1.xhtml\">The arrival</a></li>\n</ol></li>\n<li><a href=\"chapter-2.xhtml\">"),
            "{nav}"
        );
        let md = markdown(&sample(), &Settings::default());
        assert!(md.contains("## Arrival\n\n### The arrival\n") && md.contains("\n## Upstream"), "{md}");

        let word = docx(&sample(), &Settings::default()).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(word)).unwrap();
        let mut document = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("word/document.xml").unwrap(), &mut document).unwrap();
        let style_before = |title: &str| {
            let at = document.find(title).unwrap();
            let style = document[..at].rfind("w:pStyle w:val=\"").unwrap();
            document[style + 16..].split('"').next().unwrap().to_string()
        };
        assert_eq!(style_before("The arrival"), "Heading2");
        assert_eq!(style_before("Upstream"), "Heading1");
    }

    #[test]
    fn writes_markdown_epub_and_word() {
        let md = markdown(&sample(), &Settings::default());
        assert!(md.starts_with("# The Ferryman’s Debt\n"));
        assert!(md.contains("## Arrival\n\n### The arrival\n"));
        assert!(md.contains("*soaked to the bone*"));
        assert!(md.contains("> A quote on two lines"));
        let epub = epub(&sample(), &Settings::default(), "urn:uuid:test", "2026-01-01T00:00:00Z").unwrap();
        assert_eq!(&epub[30..38], b"mimetype");
        let word = docx(&sample(), &Settings::default()).unwrap();
        assert!(word.starts_with(b"PK"));
    }
}
