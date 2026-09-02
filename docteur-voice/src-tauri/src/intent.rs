// Turns a transcribed French sentence into an action. Deliberately simple
// prefix/keyword matching — no LLM involved, nothing here ever leaves the
// machine, and the logic is easy to audit at a glance.

#[derive(Debug, Clone, PartialEq)]
pub enum Intent {
    OpenDocteur,
    Todo(String),
    Note(String),
}

fn strip_prefix_ci<'a>(text: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    let lower = text.to_lowercase();
    for p in prefixes {
        if lower.starts_with(p) {
            return Some(text[p.len()..].trim());
        }
    }
    None
}

pub fn detect(raw: &str) -> Intent {
    let text = raw.trim();
    let lower = text.to_lowercase();

    if lower.contains("ouvre docteur") || lower.contains("ouvrir docteur") {
        return Intent::OpenDocteur;
    }

    if let Some(rest) = strip_prefix_ci(
        text,
        &[
            "a faire ",
            "à faire ",
            "rappelle moi de ",
            "rappelle-moi de ",
            "rappelle moi ",
            "rappelle-moi ",
        ],
    ) {
        if !rest.is_empty() {
            return Intent::Todo(rest.to_string());
        }
    }

    if let Some(rest) = strip_prefix_ci(text, &["note ", "note: ", "note : "]) {
        if !rest.is_empty() {
            return Intent::Note(rest.to_string());
        }
    }

    // Free text with no recognized prefix defaults to a note — dictating
    // never gets silently discarded.
    Intent::Note(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_open() {
        assert_eq!(detect("ouvre Docteur"), Intent::OpenDocteur);
    }

    #[test]
    fn detects_todo() {
        assert_eq!(
            detect("à faire acheter du pain"),
            Intent::Todo("acheter du pain".to_string())
        );
        assert_eq!(
            detect("rappelle-moi d'appeler le medecin"),
            Intent::Todo("d'appeler le medecin".to_string())
        );
    }

    #[test]
    fn detects_note_prefix() {
        assert_eq!(
            detect("note idee pour le projet X"),
            Intent::Note("idee pour le projet X".to_string())
        );
    }

    #[test]
    fn free_text_defaults_to_note() {
        assert_eq!(
            detect("penser a arroser les plantes"),
            Intent::Note("penser a arroser les plantes".to_string())
        );
    }
}
