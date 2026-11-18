// VTC-164 companion schema pinned at 9a53e09755f7731da865aa3bdc4bac8a7cafe724.
export const qualificationSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:vtc:companion:v1",
  "$defs": {
    "Game": {
      "type": "string",
      "enum": [
        "ets2",
        "ats"
      ]
    },
    "Decimal": {
      "type": "string",
      "maxLength": 39,
      "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
    },
    "SecurityScope": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_-]{43}$"
    },
    "ResultVersion": {
      "type": "string",
      "maxLength": 128,
      "pattern": "^[A-Za-z0-9_.-]+$"
    },
    "SourceIdentity": {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "const": "ets2telemetry"
        },
        "game": {
          "$ref": "#/$defs/Game"
        },
        "pluginSessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "tripId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        }
      },
      "required": [
        "provider",
        "game",
        "pluginSessionId",
        "tripId"
      ],
      "additionalProperties": false
    },
    "SourceRequest": {
      "type": "object",
      "properties": {
        "source": {
          "$ref": "#/$defs/SourceIdentity"
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "eventId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "ifVersion": {
          "$ref": "#/$defs/ResultVersion"
        }
      },
      "required": [
        "source",
        "revision",
        "eventId"
      ],
      "additionalProperties": false
    },
    "ResultBatchInput": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SourceRequest"
          },
          "maxItems": 25,
          "minItems": 1
        }
      },
      "required": [
        "requestId",
        "items"
      ],
      "additionalProperties": false
    },
    "Limits": {
      "type": "object",
      "properties": {
        "massMinKg": {
          "oneOf": [
            {
              "type": "string",
              "maxLength": 39,
              "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
            },
            {
              "type": "null"
            }
          ]
        },
        "massMaxKg": {
          "oneOf": [
            {
              "type": "string",
              "maxLength": 39,
              "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
            },
            {
              "type": "null"
            }
          ]
        },
        "distanceMinM": {
          "oneOf": [
            {
              "type": "string",
              "maxLength": 39,
              "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
            },
            {
              "type": "null"
            }
          ]
        },
        "distanceMaxM": {
          "oneOf": [
            {
              "type": "string",
              "maxLength": 39,
              "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
            },
            {
              "type": "null"
            }
          ]
        },
        "trailers": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "any",
                "selected"
              ]
            },
            "typeIds": {
              "type": "array",
              "items": {
                "type": "string",
                "format": "uuid",
                "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
              },
              "maxItems": 100
            }
          },
          "required": [
            "mode",
            "typeIds"
          ],
          "additionalProperties": false
        },
        "adr": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "any",
                "forbidden",
                "selected"
              ]
            },
            "classes": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "1",
                  "2",
                  "3",
                  "4",
                  "6",
                  "8"
                ]
              },
              "maxItems": 6
            }
          },
          "required": [
            "mode",
            "classes"
          ],
          "additionalProperties": false
        },
        "hardModeRequired": {
          "type": "boolean"
        }
      },
      "required": [
        "massMinKg",
        "massMaxKg",
        "distanceMinM",
        "distanceMaxM",
        "trailers",
        "adr",
        "hardModeRequired"
      ],
      "additionalProperties": false
    },
    "LevelIdentity": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "editVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        }
      },
      "required": [
        "id",
        "name",
        "editVersion"
      ],
      "additionalProperties": false
    },
    "Assignment": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "startedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "Z$"
        },
        "level": {
          "$ref": "#/$defs/LevelIdentity"
        },
        "limits": {
          "$ref": "#/$defs/Limits"
        },
        "trailerDisplay": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TrailerDisplay"
          },
          "maxItems": 100
        }
      },
      "required": [
        "id",
        "startedAt",
        "level",
        "limits",
        "trailerDisplay"
      ],
      "additionalProperties": false
    },
    "Conditions": {
      "type": "object",
      "properties": {
        "requiredTrips": {
          "oneOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 2147483647
            },
            {
              "type": "null"
            }
          ]
        },
        "requiredDistanceM": {
          "oneOf": [
            {
              "type": "string",
              "maxLength": 39,
              "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "requiredTrips",
        "requiredDistanceM"
      ],
      "additionalProperties": false
    },
    "Progress": {
      "type": "object",
      "properties": {
        "creditedTrips": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "creditedDistanceM": {
          "type": "string",
          "maxLength": 39,
          "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
        },
        "conditions": {
          "$ref": "#/$defs/Conditions"
        },
        "remainingTrips": {
          "oneOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 2147483647
            },
            {
              "type": "null"
            }
          ]
        },
        "remainingDistanceM": {
          "oneOf": [
            {
              "type": "string",
              "maxLength": 39,
              "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
            },
            {
              "type": "null"
            }
          ]
        },
        "conditionsMet": {
          "type": "boolean"
        },
        "nextLevel": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
                },
                "name": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                }
              },
              "required": [
                "id",
                "name"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "terminal": {
          "type": "boolean"
        }
      },
      "required": [
        "creditedTrips",
        "creditedDistanceM",
        "conditions",
        "remainingTrips",
        "remainingDistanceM",
        "conditionsMet",
        "nextLevel",
        "terminal"
      ],
      "additionalProperties": false
    },
    "Qualification": {
      "type": "object",
      "properties": {
        "contract": {
          "type": "string",
          "const": "1.0"
        },
        "securityScope": {
          "$ref": "#/$defs/SecurityScope"
        },
        "ownerId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "game": {
          "$ref": "#/$defs/Game"
        },
        "state": {
          "type": "string",
          "enum": [
            "assigned",
            "assignment_missing",
            "unavailable"
          ]
        },
        "assignment": {
          "oneOf": [
            {
              "$ref": "#/$defs/Assignment"
            },
            {
              "type": "null"
            }
          ]
        },
        "progress": {
          "oneOf": [
            {
              "$ref": "#/$defs/Progress"
            },
            {
              "type": "null"
            }
          ]
        },
        "asOf": {
          "type": "string",
          "format": "date-time",
          "pattern": "Z$"
        },
        "progressRevision": {
          "type": "string",
          "maxLength": 20,
          "pattern": "^(0|[1-9][0-9]{0,19})$"
        },
        "refreshAfterSeconds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 60
        },
        "offlineUsableUntil": {
          "type": "string",
          "format": "date-time",
          "pattern": "Z$"
        }
      },
      "required": [
        "contract",
        "securityScope",
        "ownerId",
        "game",
        "state",
        "assignment",
        "progress",
        "asOf",
        "progressRevision",
        "refreshAfterSeconds",
        "offlineUsableUntil"
      ],
      "additionalProperties": false
    },
    "DecimalFact": {
      "type": "object",
      "properties": {
        "availability": {
          "type": "string",
          "enum": [
            "known",
            "unknown"
          ]
        },
        "value": {
          "oneOf": [
            {
              "type": "string",
              "maxLength": 39,
              "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "availability",
        "value"
      ],
      "additionalProperties": false
    },
    "CodeFact": {
      "type": "object",
      "properties": {
        "availability": {
          "type": "string",
          "enum": [
            "known",
            "unknown"
          ]
        },
        "code": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "availability",
        "code"
      ],
      "additionalProperties": false
    },
    "PreviewInput": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "contextRevision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        },
        "evidenceRevision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        },
        "game": {
          "$ref": "#/$defs/Game"
        },
        "cargo": {
          "$ref": "#/$defs/CodeFact"
        },
        "cargoMassKg": {
          "$ref": "#/$defs/DecimalFact"
        },
        "trailers": {
          "type": "object",
          "properties": {
            "complete": {
              "type": "boolean"
            },
            "items": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "code": {
                    "oneOf": [
                      {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "provenance": {
                    "type": "string",
                    "enum": [
                      "attached",
                      "previous",
                      "unknown"
                    ]
                  }
                },
                "required": [
                  "code",
                  "provenance"
                ],
                "additionalProperties": false
              },
              "maxItems": 10
            }
          },
          "required": [
            "complete",
            "items"
          ],
          "additionalProperties": false
        },
        "actualDistance": {
          "type": "object",
          "properties": {
            "availability": {
              "type": "string",
              "enum": [
                "known",
                "unknown"
              ]
            },
            "metres": {
              "oneOf": [
                {
                  "type": "string",
                  "maxLength": 39,
                  "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "support": {
              "type": "string",
              "enum": [
                "whole-trip",
                "partial",
                "unknown"
              ]
            },
            "final": {
              "type": "boolean"
            }
          },
          "required": [
            "availability",
            "metres",
            "support",
            "final"
          ],
          "additionalProperties": false
        },
        "hardMode": {
          "type": "object",
          "properties": {
            "result": {
              "type": "string",
              "enum": [
                "qualified",
                "not-qualified",
                "unknown"
              ]
            },
            "final": {
              "type": "boolean"
            }
          },
          "required": [
            "result",
            "final"
          ],
          "additionalProperties": false
        },
        "start": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "utc": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "Z$"
                },
                "basis": {
                  "type": "string",
                  "enum": [
                    "actual",
                    "unknown"
                  ]
                }
              },
              "required": [
                "utc",
                "basis"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "eventId": {
          "oneOf": [
            {
              "type": "string",
              "format": "uuid",
              "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "requestId",
        "contextRevision",
        "evidenceRevision",
        "game",
        "cargo",
        "cargoMassKg",
        "trailers",
        "actualDistance",
        "hardMode",
        "start",
        "eventId"
      ],
      "additionalProperties": false
    },
    "Rule": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "rule": {
              "type": "string",
              "const": "cargo_mass"
            },
            "result": {
              "type": "string",
              "enum": [
                "pass",
                "fail",
                "unknown"
              ]
            },
            "minKg": {
              "oneOf": [
                {
                  "type": "string",
                  "maxLength": 39,
                  "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "maxKg": {
              "oneOf": [
                {
                  "type": "string",
                  "maxLength": 39,
                  "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "observedKg": {
              "oneOf": [
                {
                  "type": "string",
                  "maxLength": 39,
                  "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "reasons": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "within_limits",
                  "unrestricted",
                  "limit_mismatch",
                  "fact_unavailable",
                  "below_minimum_growing",
                  "hard_mode_not_final",
                  "unsupported_distance",
                  "event_attendance_exemption"
                ]
              },
              "minItems": 1,
              "maxItems": 3
            }
          },
          "required": [
            "rule",
            "result",
            "minKg",
            "maxKg",
            "observedKg",
            "reasons"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "rule": {
              "type": "string",
              "const": "distance"
            },
            "result": {
              "type": "string",
              "enum": [
                "pass",
                "fail",
                "unknown"
              ]
            },
            "minM": {
              "oneOf": [
                {
                  "type": "string",
                  "maxLength": 39,
                  "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "maxM": {
              "oneOf": [
                {
                  "type": "string",
                  "maxLength": 39,
                  "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "observedM": {
              "oneOf": [
                {
                  "type": "string",
                  "maxLength": 39,
                  "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "reasons": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "within_limits",
                  "unrestricted",
                  "limit_mismatch",
                  "fact_unavailable",
                  "below_minimum_growing",
                  "hard_mode_not_final",
                  "unsupported_distance",
                  "event_attendance_exemption"
                ]
              },
              "minItems": 1,
              "maxItems": 3
            }
          },
          "required": [
            "rule",
            "result",
            "minM",
            "maxM",
            "observedM",
            "reasons"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "rule": {
              "type": "string",
              "const": "trailer_types"
            },
            "result": {
              "type": "string",
              "enum": [
                "pass",
                "fail",
                "unknown"
              ]
            },
            "mode": {
              "type": "string",
              "enum": [
                "any",
                "selected"
              ]
            },
            "allowedIds": {
              "type": "array",
              "items": {
                "type": "string",
                "format": "uuid",
                "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
              },
              "maxItems": 100
            },
            "observedIds": {
              "type": "array",
              "items": {
                "type": "string",
                "format": "uuid",
                "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
              },
              "maxItems": 10
            },
            "reasons": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "within_limits",
                  "unrestricted",
                  "limit_mismatch",
                  "fact_unavailable",
                  "below_minimum_growing",
                  "hard_mode_not_final",
                  "unsupported_distance",
                  "event_attendance_exemption"
                ]
              },
              "minItems": 1,
              "maxItems": 3
            }
          },
          "required": [
            "rule",
            "result",
            "mode",
            "allowedIds",
            "observedIds",
            "reasons"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "rule": {
              "type": "string",
              "const": "adr"
            },
            "result": {
              "type": "string",
              "enum": [
                "pass",
                "fail",
                "unknown"
              ]
            },
            "mode": {
              "type": "string",
              "enum": [
                "any",
                "forbidden",
                "selected"
              ]
            },
            "allowedClasses": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "1",
                  "2",
                  "3",
                  "4",
                  "6",
                  "8"
                ]
              },
              "maxItems": 6
            },
            "observed": {
              "oneOf": [
                {
                  "type": "string",
                  "enum": [
                    "1",
                    "2",
                    "3",
                    "4",
                    "6",
                    "8",
                    "none"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "reasons": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "within_limits",
                  "unrestricted",
                  "limit_mismatch",
                  "fact_unavailable",
                  "below_minimum_growing",
                  "hard_mode_not_final",
                  "unsupported_distance",
                  "event_attendance_exemption"
                ]
              },
              "minItems": 1,
              "maxItems": 3
            }
          },
          "required": [
            "rule",
            "result",
            "mode",
            "allowedClasses",
            "observed",
            "reasons"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "rule": {
              "type": "string",
              "const": "hard_mode"
            },
            "result": {
              "type": "string",
              "enum": [
                "pass",
                "fail",
                "unknown"
              ]
            },
            "required": {
              "type": "boolean"
            },
            "observed": {
              "oneOf": [
                {
                  "type": "string",
                  "enum": [
                    "qualified",
                    "not-qualified",
                    "unknown"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "reasons": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "within_limits",
                  "unrestricted",
                  "limit_mismatch",
                  "fact_unavailable",
                  "below_minimum_growing",
                  "hard_mode_not_final",
                  "unsupported_distance",
                  "event_attendance_exemption"
                ]
              },
              "minItems": 1,
              "maxItems": 3
            }
          },
          "required": [
            "rule",
            "result",
            "required",
            "observed",
            "reasons"
          ],
          "additionalProperties": false
        }
      ]
    },
    "Preview": {
      "type": "object",
      "properties": {
        "contract": {
          "type": "string",
          "const": "1.0"
        },
        "securityScope": {
          "$ref": "#/$defs/SecurityScope"
        },
        "requestId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "contextRevision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "evidenceRevision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "evaluatedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "Z$"
        },
        "basis": {
          "type": "string",
          "enum": [
            "historical_assignment",
            "current_projection",
            "unavailable"
          ]
        },
        "assignment": {
          "oneOf": [
            {
              "$ref": "#/$defs/Assignment"
            },
            {
              "type": "null"
            }
          ]
        },
        "outcome": {
          "type": "string",
          "enum": [
            "pass",
            "fail",
            "unknown"
          ]
        },
        "rules": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Rule"
          },
          "maxItems": 5
        },
        "reasons": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "below_minimum_growing",
              "hard_mode_not_final",
              "unsupported_distance",
              "fact_unavailable",
              "limit_mismatch",
              "assignment_missing",
              "module_unavailable",
              "event_unresolved"
            ]
          },
          "maxItems": 10
        },
        "eventExempt": {
          "type": "boolean"
        },
        "applicability": {
          "type": "object",
          "properties": {
            "expiresAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "Z$"
            },
            "contextRevision": {
              "type": "integer",
              "minimum": 0,
              "maximum": 2147483647
            },
            "minimumDistanceM": {
              "oneOf": [
                {
                  "type": "string",
                  "maxLength": 39,
                  "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "maximumDistanceM": {
              "oneOf": [
                {
                  "type": "string",
                  "maxLength": 39,
                  "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "qualificationRevision": {
              "type": "string",
              "maxLength": 20,
              "pattern": "^(0|[1-9][0-9]{0,19})$"
            },
            "requiresQualificationRefresh": {
              "type": "boolean"
            }
          },
          "required": [
            "expiresAt",
            "contextRevision",
            "minimumDistanceM",
            "maximumDistanceM",
            "qualificationRevision",
            "requiresQualificationRefresh"
          ],
          "additionalProperties": false
        },
        "provisional": {
          "type": "boolean",
          "const": true
        },
        "trailerDisplay": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TrailerDisplay"
          },
          "maxItems": 110
        }
      },
      "required": [
        "contract",
        "securityScope",
        "requestId",
        "contextRevision",
        "evidenceRevision",
        "evaluatedAt",
        "basis",
        "assignment",
        "outcome",
        "rules",
        "reasons",
        "eventExempt",
        "applicability",
        "provisional",
        "trailerDisplay"
      ],
      "additionalProperties": false
    },
    "Assessment": {
      "type": "object",
      "properties": {
        "availability": {
          "type": "string",
          "enum": [
            "retained",
            "historical_unavailable"
          ]
        },
        "decisionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "decisionSequence": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        },
        "decidedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "Z$"
        },
        "factId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "sourceMessageId": {
          "oneOf": [
            {
              "type": "string",
              "format": "uuid",
              "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "sourceRevision": {
          "oneOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "sourceEventId": {
          "oneOf": [
            {
              "type": "string",
              "format": "uuid",
              "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "materialIdentity": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "assignmentId": {
          "oneOf": [
            {
              "type": "string",
              "format": "uuid",
              "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "level": {
          "oneOf": [
            {
              "$ref": "#/$defs/LevelIdentity"
            },
            {
              "type": "null"
            }
          ]
        },
        "limits": {
          "oneOf": [
            {
              "$ref": "#/$defs/Limits"
            },
            {
              "type": "null"
            }
          ]
        },
        "outcome": {
          "oneOf": [
            {
              "type": "string",
              "enum": [
                "pass",
                "fail",
                "unknown"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "rules": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Rule"
          },
          "maxItems": 5
        },
        "eventExempt": {
          "type": "boolean"
        },
        "reasons": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "qualification_cargo_mass",
              "qualification_distance",
              "qualification_trailer",
              "qualification_adr",
              "qualification_hard_mode",
              "qualification_unknown",
              "qualification_level_unknown",
              "qualification_attribution_time_unknown",
              "event_attendance_exemption"
            ]
          },
          "maxItems": 10
        },
        "trailerDisplay": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TrailerDisplay"
          },
          "maxItems": 100
        },
        "assessedSource": {
          "oneOf": [
            {
              "$ref": "#/$defs/SourceIdentity"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "availability",
        "decisionId",
        "decisionSequence",
        "decidedAt",
        "factId",
        "sourceMessageId",
        "sourceRevision",
        "sourceEventId",
        "materialIdentity",
        "assignmentId",
        "level",
        "limits",
        "outcome",
        "rules",
        "eventExempt",
        "reasons",
        "trailerDisplay",
        "assessedSource"
      ],
      "additionalProperties": false
    },
    "Result": {
      "type": "object",
      "properties": {
        "source": {
          "$ref": "#/$defs/SourceIdentity"
        },
        "requestedRevision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "requestedEventId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "version": {
          "$ref": "#/$defs/ResultVersion"
        },
        "resultRevision": {
          "type": "string",
          "maxLength": 20,
          "pattern": "^(0|[1-9][0-9]{0,19})$"
        },
        "unchanged": {
          "type": "boolean"
        },
        "receipt": {
          "type": "string",
          "enum": [
            "not_received",
            "received"
          ]
        },
        "state": {
          "type": "string",
          "enum": [
            "not_received",
            "processing",
            "review",
            "decided"
          ]
        },
        "requestedSourceMessageId": {
          "oneOf": [
            {
              "type": "string",
              "format": "uuid",
              "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "latestSourceRevision": {
          "oneOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "canonicalTripId": {
          "oneOf": [
            {
              "type": "string",
              "format": "uuid",
              "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "sourceOutcome": {
          "oneOf": [
            {
              "type": "string",
              "enum": [
                "open",
                "delivered",
                "cancelled",
                "none"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "companyDecision": {
          "type": "string",
          "enum": [
            "unassessed",
            "pending_review",
            "accepted",
            "rejected"
          ]
        },
        "assessmentPending": {
          "type": "boolean"
        },
        "correctionPending": {
          "type": "boolean"
        },
        "assessmentBasis": {
          "type": "string",
          "enum": [
            "none",
            "current",
            "predecessor"
          ]
        },
        "assessment": {
          "oneOf": [
            {
              "$ref": "#/$defs/Assessment"
            },
            {
              "type": "null"
            }
          ]
        },
        "credit": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "credited": {
                  "type": "boolean"
                },
                "trips": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 2147483647
                },
                "actualDistanceM": {
                  "oneOf": [
                    {
                      "type": "string",
                      "maxLength": 39,
                      "pattern": "^(0|[1-9][0-9]{0,19})(\\.[0-9]{0,17}[1-9])?$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "assignmentId": {
                  "oneOf": [
                    {
                      "type": "string",
                      "format": "uuid",
                      "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "credited",
                "trips",
                "actualDistanceM",
                "assignmentId"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "source",
        "requestedRevision",
        "requestedEventId",
        "version",
        "resultRevision",
        "unchanged",
        "receipt",
        "state",
        "requestedSourceMessageId",
        "latestSourceRevision",
        "canonicalTripId",
        "sourceOutcome",
        "companyDecision",
        "assessmentPending",
        "correctionPending",
        "assessmentBasis",
        "assessment",
        "credit"
      ],
      "additionalProperties": false
    },
    "ResultBatch": {
      "type": "object",
      "properties": {
        "contract": {
          "type": "string",
          "const": "1.0"
        },
        "securityScope": {
          "$ref": "#/$defs/SecurityScope"
        },
        "requestId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "asOf": {
          "type": "string",
          "format": "date-time",
          "pattern": "Z$"
        },
        "refreshAfterSeconds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 60
        },
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Result"
          },
          "maxItems": 25
        }
      },
      "required": [
        "contract",
        "securityScope",
        "requestId",
        "asOf",
        "refreshAfterSeconds",
        "items"
      ],
      "additionalProperties": false
    },
    "Capabilities": {
      "type": "object",
      "properties": {
        "contract": {
          "type": "string",
          "const": "1.0"
        },
        "securityScope": {
          "$ref": "#/$defs/SecurityScope"
        },
        "capability": {
          "type": "string",
          "const": "companion.own.v1"
        },
        "games": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Game"
          },
          "maxItems": 2
        },
        "qualificationEnabled": {
          "type": "boolean"
        },
        "previewEnabled": {
          "type": "boolean"
        },
        "resultsEnabled": {
          "type": "boolean"
        },
        "maxBatch": {
          "type": "integer",
          "const": 25
        },
        "maxBodyBytes": {
          "type": "integer",
          "const": 16384
        },
        "previewTtlSeconds": {
          "type": "integer",
          "const": 5
        },
        "pollMinimumSeconds": {
          "type": "integer",
          "const": 5
        }
      },
      "required": [
        "contract",
        "securityScope",
        "capability",
        "games",
        "qualificationEnabled",
        "previewEnabled",
        "resultsEnabled",
        "maxBatch",
        "maxBodyBytes",
        "previewTtlSeconds",
        "pollMinimumSeconds"
      ],
      "additionalProperties": false
    },
    "Error": {
      "type": "object",
      "properties": {
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "enum": [
                "TOKEN_INVALID",
                "INGESTION_FORBIDDEN",
                "CAPABILITY_REQUIRED",
                "INVALID_PAYLOAD",
                "PAYLOAD_TOO_LARGE",
                "UNSUPPORTED_MEDIA_TYPE",
                "NOT_FOUND",
                "RATE_LIMITED",
                "TEMPORARILY_UNAVAILABLE"
              ]
            },
            "retryable": {
              "type": "boolean"
            }
          },
          "required": [
            "code",
            "retryable"
          ],
          "additionalProperties": false
        },
        "requestId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        }
      },
      "required": [
        "error",
        "requestId"
      ],
      "additionalProperties": false
    },
    "TrailerDisplay": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
        },
        "code": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            {
              "type": "null"
            }
          ]
        },
        "groupCode": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            {
              "type": "null"
            }
          ]
        },
        "nameEn": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            {
              "type": "null"
            }
          ]
        },
        "nameRu": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            {
              "type": "null"
            }
          ]
        },
        "basis": {
          "type": "string",
          "const": "current_catalog"
        },
        "asOf": {
          "type": "string",
          "format": "date-time",
          "pattern": "Z$"
        }
      },
      "required": [
        "id",
        "code",
        "groupCode",
        "nameEn",
        "nameRu",
        "basis",
        "asOf"
      ],
      "additionalProperties": false
    }
  }
};
