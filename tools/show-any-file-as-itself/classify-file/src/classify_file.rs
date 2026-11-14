// crates/file-classification/src/slot_work/classify_file.rs
//
// Classify supplied file paths without reading file contents.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileClassificationRequest {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub mime_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileClassification {
    pub language: &'static str,
    pub renderer: &'static str,
    pub icon: &'static str,
    pub label: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<&'static str>,
}

#[derive(Debug, Clone, Copy)]
struct Rule {
    extensions: &'static [&'static str],
    language: &'static str,
    renderer: &'static str,
    icon: &'static str,
    label: &'static str,
    mime_type: Option<&'static str>,
}

macro_rules! rule {
    ($extensions:expr, $language:expr, $renderer:expr, $icon:expr, $label:expr) => {
        Rule {
            extensions: $extensions,
            language: $language,
            renderer: $renderer,
            icon: $icon,
            label: $label,
            mime_type: None,
        }
    };
    ($extensions:expr, $language:expr, $renderer:expr, $icon:expr, $label:expr, $mime_type:expr) => {
        Rule {
            extensions: $extensions,
            language: $language,
            renderer: $renderer,
            icon: $icon,
            label: $label,
            mime_type: Some($mime_type),
        }
    };
}

const DEFAULT_CLASSIFICATION: FileClassification = FileClassification {
    language: "text",
    renderer: "raw",
    icon: "File",
    label: "Plain Text",
    mime_type: None,
};

const RULES: &[Rule] = &[
    rule!(&[".ts"], "typescript", "code", "FileCode2", "TypeScript"),
    rule!(
        &[".tsx"],
        "typescript",
        "code",
        "FileCode2",
        "TypeScript JSX"
    ),
    rule!(&[".js"], "javascript", "code", "FileCode2", "JavaScript"),
    rule!(
        &[".jsx"],
        "javascript",
        "code",
        "FileCode2",
        "JavaScript JSX"
    ),
    rule!(
        &[".mjs"],
        "javascript",
        "code",
        "FileCode2",
        "JavaScript Module"
    ),
    rule!(&[".html"], "html", "code", "FileCode2", "HTML"),
    rule!(&[".css"], "css", "code", "Palette", "CSS"),
    rule!(&[".scss"], "scss", "code", "Palette", "SCSS"),
    rule!(&[".sass"], "sass", "code", "Palette", "Sass"),
    rule!(&[".less"], "less", "code", "Palette", "Less"),
    rule!(&[".vue"], "vue", "code", "FileCode2", "Vue"),
    rule!(&[".svelte"], "svelte", "code", "FileCode2", "Svelte"),
    rule!(&[".rs"], "rust", "code", "FileCode2", "Rust"),
    rule!(&[".go"], "go", "code", "FileCode2", "Go"),
    rule!(&[".c"], "c", "code", "FileCode2", "C"),
    rule!(&[".cpp", ".cc", ".cxx"], "cpp", "code", "FileCode2", "C++"),
    rule!(&[".h"], "c", "code", "FileCode2", "C Header"),
    rule!(&[".hpp"], "cpp", "code", "FileCode2", "C++ Header"),
    rule!(&[".java"], "java", "code", "FileCode2", "Java"),
    rule!(&[".kt"], "kotlin", "code", "FileCode2", "Kotlin"),
    rule!(&[".swift"], "swift", "code", "FileCode2", "Swift"),
    rule!(&[".zig"], "zig", "code", "FileCode2", "Zig"),
    rule!(&[".py", ".pyw"], "python", "code", "FileCode2", "Python"),
    rule!(&[".rb"], "ruby", "code", "FileCode2", "Ruby"),
    rule!(&[".lua"], "lua", "code", "FileCode2", "Lua"),
    rule!(&[".pl"], "perl", "code", "FileCode2", "Perl"),
    rule!(&[".pm"], "perl", "code", "FileCode2", "Perl Module"),
    rule!(&[".php"], "php", "code", "FileCode2", "PHP"),
    rule!(&[".sh"], "bash", "code", "Terminal", "Shell Script"),
    rule!(&[".bash"], "bash", "code", "Terminal", "Bash"),
    rule!(&[".zsh"], "zsh", "code", "Terminal", "Zsh"),
    rule!(&[".fish"], "fish", "code", "Terminal", "Fish"),
    rule!(&[".ps1"], "powershell", "code", "Terminal", "PowerShell"),
    rule!(&[".json"], "json", "code", "FileJson", "JSON"),
    rule!(&[".yaml", ".yml"], "yaml", "code", "FileText", "YAML"),
    rule!(&[".toml"], "toml", "code", "FileText", "TOML"),
    rule!(&[".xml"], "xml", "code", "FileText", "XML"),
    rule!(&[".csv"], "text", "code", "Table", "CSV"),
    rule!(&[".tsv"], "text", "code", "Table", "TSV"),
    rule!(&[".env"], "ini", "code", "Settings", "Environment"),
    rule!(&[".ini"], "ini", "code", "Settings", "INI Config"),
    rule!(&[".conf"], "nginx", "code", "Settings", "Config"),
    rule!(&[".config"], "text", "code", "Settings", "Config"),
    rule!(
        &["Dockerfile", ".Dockerfile"],
        "dockerfile",
        "code",
        "Box",
        "Dockerfile"
    ),
    rule!(
        &["Makefile", ".Makefile"],
        "makefile",
        "code",
        "Wrench",
        "Makefile"
    ),
    rule!(&[".gitignore"], "text", "code", "GitBranch", ".gitignore"),
    rule!(
        &[".editorconfig"],
        "ini",
        "code",
        "Settings",
        ".editorconfig"
    ),
    rule!(&[".md"], "markdown", "markdown", "FileText", "Markdown"),
    rule!(&[".mdx"], "markdown", "markdown", "FileText", "MDX"),
    rule!(
        &[".rst"],
        "restructuredtext",
        "code",
        "FileText",
        "reStructuredText"
    ),
    rule!(&[".adoc"], "asciidoc", "code", "FileText", "AsciiDoc"),
    rule!(&[".tex"], "latex", "code", "FileText", "LaTeX"),
    rule!(&[".sql"], "sql", "code", "Database", "SQL"),
    rule!(&[".sqlite"], "sql", "code", "Database", "SQLite"),
    rule!(&[".diff"], "diff", "diff", "GitCompare", "Diff"),
    rule!(&[".patch"], "diff", "diff", "GitCompare", "Patch"),
    rule!(
        &[".png"],
        "text",
        "image",
        "Image",
        "PNG Image",
        "image/png"
    ),
    rule!(
        &[".jpg", ".jpeg"],
        "text",
        "image",
        "Image",
        "JPEG Image",
        "image/jpeg"
    ),
    rule!(
        &[".gif"],
        "text",
        "image",
        "Image",
        "GIF Image",
        "image/gif"
    ),
    rule!(
        &[".webp"],
        "text",
        "image",
        "Image",
        "WebP Image",
        "image/webp"
    ),
    rule!(
        &[".svg"],
        "xml",
        "image",
        "Image",
        "SVG Image",
        "image/svg+xml"
    ),
    rule!(&[".ico"], "text", "image", "Image", "Icon", "image/x-icon"),
    rule!(&[".bmp"], "text", "image", "Image", "Bitmap", "image/bmp"),
    rule!(&[".txt"], "text", "raw", "FileText", "Plain Text"),
    rule!(&[".log"], "text", "raw", "FileText", "Log"),
];

fn classify_from_rule(rule: Rule) -> FileClassification {
    FileClassification {
        language: rule.language,
        renderer: rule.renderer,
        icon: rule.icon,
        label: rule.label,
        mime_type: rule.mime_type,
    }
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn extension(path: &str) -> Option<String> {
    let name = file_name(path);
    let index = name.rfind('.')?;
    if index == 0 {
        return None;
    }
    Some(name[index..].to_ascii_lowercase())
}

pub fn classify_file(request: &FileClassificationRequest) -> FileClassification {
    let path = request.path.trim();
    if path.is_empty() {
        return DEFAULT_CLASSIFICATION;
    }

    let name = file_name(path);
    for rule in RULES {
        if rule.extensions.contains(&name) {
            return classify_from_rule(*rule);
        }
    }

    if let Some(ext) = extension(path) {
        for rule in RULES {
            if rule
                .extensions
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(&ext))
            {
                return classify_from_rule(*rule);
            }
        }
    }

    DEFAULT_CLASSIFICATION
}

pub fn classify_file_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let request: FileClassificationRequest = serde_json::from_slice(bytes)
        .map_err(|err| format!("file-classification: request JSON parse failed: {err}"))?;
    let reply = classify_file(&request);
    serde_json::to_vec(&reply)
        .map_err(|err| format!("file-classification: reply JSON serialize failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify(path: &str) -> FileClassification {
        classify_file(&FileClassificationRequest {
            path: path.to_string(),
            mime_hint: None,
        })
    }

    #[test]
    fn classifies_common_code_paths() {
        assert_eq!(classify("src/app.tsx").language, "typescript");
        assert_eq!(classify("src/app.tsx").renderer, "code");
        assert_eq!(classify("README.md").renderer, "markdown");
        assert_eq!(classify("changes.diff").renderer, "diff");
    }

    #[test]
    fn classifies_images_with_mime_types() {
        let png = classify("image.png");
        assert_eq!(png.renderer, "image");
        assert_eq!(png.mime_type, Some("image/png"));
    }

    #[test]
    fn handles_exact_names_and_unknowns() {
        assert_eq!(classify("Dockerfile").language, "dockerfile");
        assert_eq!(classify("unknown.nope").renderer, "raw");
    }
}
