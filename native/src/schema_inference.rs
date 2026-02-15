use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct JsonSchema {
    #[serde(skip_serializing_if = "Option::is_none")]
    r#type: Option<SchemaType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    properties: Option<BTreeMap<String, JsonSchema>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    items: Option<Box<JsonSchema>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    required: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(untagged)]
enum SchemaType {
    Single(String),
    Multiple(Vec<String>),
}

impl SchemaType {
    fn to_vec(&self) -> Vec<String> {
        match self {
            SchemaType::Single(s) => vec![s.clone()],
            SchemaType::Multiple(v) => v.clone(),
        }
    }

    fn from_set(set: &BTreeSet<String>) -> SchemaType {
        let types: Vec<String> = set.iter().cloned().collect();
        if types.len() == 1 {
            SchemaType::Single(types[0].clone())
        } else {
            SchemaType::Multiple(types)
        }
    }
}

// ─── Inference ──────────────────────────────────────────────────────

fn infer_single(value: &serde_json::Value) -> JsonSchema {
    match value {
        serde_json::Value::Null => JsonSchema {
            r#type: Some(SchemaType::Single("null".to_string())),
            properties: None,
            items: None,
            required: None,
        },
        serde_json::Value::Bool(_) => JsonSchema {
            r#type: Some(SchemaType::Single("boolean".to_string())),
            properties: None,
            items: None,
            required: None,
        },
        serde_json::Value::Number(n) => {
            let type_name = if n.is_i64() || n.is_u64() {
                "integer"
            } else {
                "number"
            };
            JsonSchema {
                r#type: Some(SchemaType::Single(type_name.to_string())),
                properties: None,
                items: None,
                required: None,
            }
        }
        serde_json::Value::String(_) => JsonSchema {
            r#type: Some(SchemaType::Single("string".to_string())),
            properties: None,
            items: None,
            required: None,
        },
        serde_json::Value::Array(arr) => {
            if arr.is_empty() {
                return JsonSchema {
                    r#type: Some(SchemaType::Single("array".to_string())),
                    properties: None,
                    items: Some(Box::new(JsonSchema {
                        r#type: None,
                        properties: None,
                        items: None,
                        required: None,
                    })),
                    required: None,
                };
            }
            let item_schemas: Vec<JsonSchema> = arr.iter().map(infer_single).collect();
            let merged = item_schemas
                .into_iter()
                .reduce(merge_schemas)
                .unwrap_or(JsonSchema {
                    r#type: None,
                    properties: None,
                    items: None,
                    required: None,
                });
            JsonSchema {
                r#type: Some(SchemaType::Single("array".to_string())),
                properties: None,
                items: Some(Box::new(merged)),
                required: None,
            }
        }
        serde_json::Value::Object(map) => {
            let mut properties = BTreeMap::new();
            let mut required: Vec<String> = Vec::new();
            for (key, val) in map {
                properties.insert(key.clone(), infer_single(val));
                required.push(key.clone());
            }
            required.sort();
            JsonSchema {
                r#type: Some(SchemaType::Single("object".to_string())),
                properties: Some(properties),
                items: None,
                required: if required.is_empty() {
                    None
                } else {
                    Some(required)
                },
            }
        }
    }
}

fn merge_schemas(a: JsonSchema, b: JsonSchema) -> JsonSchema {
    let type_a = a
        .r#type
        .as_ref()
        .map(|t| t.to_vec())
        .unwrap_or_else(|| vec!["null".to_string()]);
    let type_b = b
        .r#type
        .as_ref()
        .map(|t| t.to_vec())
        .unwrap_or_else(|| vec!["null".to_string()]);

    let mut all_types: BTreeSet<String> = BTreeSet::new();
    all_types.extend(type_a.iter().cloned());
    all_types.extend(type_b.iter().cloned());

    // If both objects, merge properties
    if type_a.contains(&"object".to_string()) && type_b.contains(&"object".to_string()) {
        let props_a = a.properties.unwrap_or_default();
        let props_b = b.properties.unwrap_or_default();

        let req_a: BTreeSet<String> = a.required.unwrap_or_default().into_iter().collect();
        let req_b: BTreeSet<String> = b.required.unwrap_or_default().into_iter().collect();

        let mut merged_props = BTreeMap::new();
        let mut all_keys: BTreeSet<String> = BTreeSet::new();
        all_keys.extend(props_a.keys().cloned());
        all_keys.extend(props_b.keys().cloned());

        let mut required = Vec::new();

        for key in &all_keys {
            let pa = props_a.get(key);
            let pb = props_b.get(key);
            match (pa, pb) {
                (Some(sa), Some(sb)) => {
                    merged_props.insert(key.clone(), merge_schemas(sa.clone(), sb.clone()));
                    if req_a.contains(key) && req_b.contains(key) {
                        required.push(key.clone());
                    }
                }
                (Some(s), None) | (None, Some(s)) => {
                    merged_props.insert(key.clone(), s.clone());
                }
                (None, None) => {}
            }
        }

        required.sort();

        return JsonSchema {
            r#type: Some(SchemaType::from_set(&all_types)),
            properties: Some(merged_props),
            items: None,
            required: if required.is_empty() {
                None
            } else {
                Some(required)
            },
        };
    }

    // If both arrays, merge items
    if type_a.contains(&"array".to_string()) && type_b.contains(&"array".to_string()) {
        let merged_items = match (a.items, b.items) {
            (Some(ia), Some(ib)) => Some(Box::new(merge_schemas(*ia, *ib))),
            (Some(i), None) | (None, Some(i)) => Some(i),
            (None, None) => None,
        };
        return JsonSchema {
            r#type: Some(SchemaType::from_set(&all_types)),
            properties: None,
            items: merged_items,
            required: None,
        };
    }

    // integer + number -> number
    if all_types.contains("integer") && all_types.contains("number") {
        all_types.remove("integer");
    }

    JsonSchema {
        r#type: Some(SchemaType::from_set(&all_types)),
        properties: None,
        items: None,
        required: None,
    }
}

// ─── Public API ─────────────────────────────────────────────────────

#[napi]
pub fn infer_schema(samples_json: String) -> napi::Result<String> {
    let samples: Vec<serde_json::Value> = serde_json::from_str(&samples_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse samples: {}", e)))?;

    if samples.is_empty() {
        return serde_json::to_string(&JsonSchema {
            r#type: None,
            properties: None,
            items: None,
            required: None,
        })
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)));
    }

    let schemas: Vec<JsonSchema> = samples.iter().map(infer_single).collect();
    let merged = schemas
        .into_iter()
        .reduce(merge_schemas)
        .unwrap_or(JsonSchema {
            r#type: None,
            properties: None,
            items: None,
            required: None,
        });

    serde_json::to_string(&merged)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize schema: {}", e)))
}
