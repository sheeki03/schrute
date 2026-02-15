use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverInput {
    samples: Vec<SampleInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleInput {
    headers: HashMap<String, String>,
    query_params: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    declared_inputs: Option<HashMap<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParameterEvidence {
    field_path: String,
    classification: String, // "parameter" | "ephemeral" | "constant"
    observed_values: Vec<String>,
    correlates_with_input: bool,
    volatility: f64,
}

struct FieldObservation {
    path: String,
    location: String,
    values: Vec<String>,
}

// ─── Observation Collection ─────────────────────────────────────────

fn collect_observations(samples: &[SampleInput]) -> HashMap<String, FieldObservation> {
    let mut observations: HashMap<String, FieldObservation> = HashMap::new();

    for sample in samples {
        // Headers
        for (key, value) in &sample.headers {
            let path = format!("header.{}", key);
            let obs = observations.entry(path.clone()).or_insert(FieldObservation {
                path: path.clone(),
                location: "header".to_string(),
                values: Vec::new(),
            });
            obs.values.push(value.clone());
        }

        // Query params
        for (key, value) in &sample.query_params {
            let path = format!("query.{}", key);
            let obs = observations.entry(path.clone()).or_insert(FieldObservation {
                path: path.clone(),
                location: "query".to_string(),
                values: Vec::new(),
            });
            obs.values.push(value.clone());
        }

        // Body (JSON)
        if let Some(body) = &sample.body {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
                if let Some(obj) = parsed.as_object() {
                    // GraphQL variables
                    if let Some(vars) = obj.get("variables").and_then(|v| v.as_object()) {
                        collect_json_paths(
                            &serde_json::Value::Object(vars.clone()),
                            "graphql_var",
                            &mut observations,
                            "graphql_variable",
                        );
                    }
                    collect_json_paths(
                        &serde_json::Value::Object(obj.clone()),
                        "body",
                        &mut observations,
                        "body",
                    );
                }
            }
        }
    }

    observations
}

fn collect_json_paths(
    obj: &serde_json::Value,
    prefix: &str,
    observations: &mut HashMap<String, FieldObservation>,
    location: &str,
) {
    match obj {
        serde_json::Value::String(_) | serde_json::Value::Number(_) | serde_json::Value::Bool(_) => {
            let val_str = match obj {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let obs = observations
                .entry(prefix.to_string())
                .or_insert(FieldObservation {
                    path: prefix.to_string(),
                    location: location.to_string(),
                    values: Vec::new(),
                });
            obs.values.push(val_str);
        }
        serde_json::Value::Array(arr) => {
            for (i, item) in arr.iter().enumerate() {
                collect_json_paths(
                    item,
                    &format!("{}[{}]", prefix, i),
                    observations,
                    location,
                );
            }
        }
        serde_json::Value::Object(map) => {
            for (key, value) in map {
                collect_json_paths(value, &format!("{}.{}", prefix, key), observations, location);
            }
        }
        _ => {}
    }
}

// ─── Classification ─────────────────────────────────────────────────

fn compute_volatility(values: &[String]) -> f64 {
    if values.len() <= 1 {
        return 0.0;
    }
    let unique: HashSet<&String> = values.iter().collect();
    unique.len() as f64 / values.len() as f64
}

fn check_input_correlation(obs: &FieldObservation, samples: &[SampleInput]) -> bool {
    for sample in samples {
        if let Some(inputs) = &sample.declared_inputs {
            for input_value in inputs.values() {
                if obs
                    .values
                    .iter()
                    .any(|v| v == input_value || v.contains(input_value))
                {
                    return true;
                }
            }
        }
    }
    false
}

fn classify_field(obs: &FieldObservation, samples: &[SampleInput]) -> String {
    let unique: HashSet<&String> = obs.values.iter().collect();

    // Constant: same value across all samples
    if unique.len() == 1 {
        return "constant".to_string();
    }

    // Check input correlation
    if check_input_correlation(obs, samples) {
        return "parameter".to_string();
    }

    let volatility = compute_volatility(&obs.values);

    // High volatility + no input correlation = ephemeral
    if volatility > 0.9 {
        return "ephemeral".to_string();
    }

    // Medium volatility = likely parameter
    if volatility > 0.0 && volatility <= 0.9 {
        return "parameter".to_string();
    }

    "ephemeral".to_string()
}

// ─── Public API ─────────────────────────────────────────────────────

#[napi]
pub fn discover_params(input_json: String) -> napi::Result<String> {
    let input: DiscoverInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input: {}", e)))?;

    if input.samples.len() < 2 {
        return serde_json::to_string(&Vec::<ParameterEvidence>::new())
            .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)));
    }

    let observations = collect_observations(&input.samples);
    let mut evidence: Vec<ParameterEvidence> = Vec::new();

    for (_key, obs) in &observations {
        let classification = classify_field(obs, &input.samples);
        let correlates_with_input = check_input_correlation(obs, &input.samples);
        let volatility = compute_volatility(&obs.values);

        evidence.push(ParameterEvidence {
            field_path: obs.path.clone(),
            classification,
            observed_values: obs.values.clone(), // Note: in production, these would be redacted
            correlates_with_input,
            volatility,
        });
    }

    serde_json::to_string(&evidence)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize evidence: {}", e)))
}
