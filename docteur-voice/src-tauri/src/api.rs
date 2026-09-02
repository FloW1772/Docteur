// Talks to cortex-server's local API — ONLY ever localhost/127.0.0.1, checked
// explicitly below regardless of what's in the config file, so a mistyped
// api_base can never turn this into a call to some remote host.

use serde_json::json;
use uuid::Uuid;

fn is_local_only(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(u) => matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("::1")),
        Err(_) => false,
    }
}

/// Returns Ok(true) if the todo item was created via the API, Ok(false) if
/// the server simply isn't reachable (caller should fall back to the inbox
/// drop), Err on an actual local misconfiguration (e.g. non-local api_base).
pub async fn add_todo(api_base: &str, content: &str) -> Result<bool, String> {
    if !is_local_only(api_base) {
        return Err(format!(
            "api_base doit pointer vers localhost/127.0.0.1, refuse : {api_base}"
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;

    let body = json!({
        "id": Uuid::new_v4().to_string(),
        "type": "task",
        "title": content,
        "note": "Ajoute par Docteur Voice (dictee)",
        "priority": 0,
    });

    let result = client
        .post(format!("{api_base}/api/todo"))
        .json(&body)
        .send()
        .await;

    match result {
        Ok(resp) if resp.status().is_success() => Ok(true),
        Ok(_) => Ok(false),  // server responded but rejected it — fall back to inbox
        Err(_) => Ok(false), // not reachable (Docteur closed) — fall back to inbox
    }
}
