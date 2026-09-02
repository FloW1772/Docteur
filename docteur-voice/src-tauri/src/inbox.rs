// Drops a .json file into cortex-server/data/inbox/ — the SAME mechanism
// Docteur's own inbox watcher already reads (see cortex-server/src/lib/
// inbox-watcher.js). One-way filesystem write, no network endpoint, nothing
// new to trust: this is the safest possible channel into Docteur, and it
// works whether or not the server is currently running.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
struct InboxFile<'a> {
    title: String,
    content: &'a str,
    source: &'a str,
    tags: Vec<&'a str>,
}

pub fn drop_note(inbox_dir: &str, content: &str, tag: Option<&str>) -> Result<(), String> {
    let dir = Path::new(inbox_dir);
    if !dir.exists() {
        return Err(format!("dossier inbox introuvable : {inbox_dir}"));
    }

    let title = first_words_as_title(content);
    let file = InboxFile {
        title,
        content,
        source: "docteur-voice",
        tags: tag.into_iter().collect(),
    };

    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    let filename = format!("voice-{}.json", uuid::Uuid::new_v4());
    std::fs::write(dir.join(filename), json).map_err(|e| format!("ecriture inbox impossible : {e}"))
}

fn first_words_as_title(content: &str) -> String {
    let words: Vec<&str> = content.split_whitespace().take(8).collect();
    let mut title = words.join(" ");
    if title.len() > 80 {
        title.truncate(80);
    }
    if title.is_empty() {
        title = "Note vocale".to_string();
    }
    title
}
