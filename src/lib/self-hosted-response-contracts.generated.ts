// @generated from src/server/self-hosted/openapi.ts by scripts/generate-selfhost-sdk.ts — DO NOT EDIT.
// Compact runtime response contracts. Regenerate with: bun run scripts/generate-selfhost-sdk.ts
export interface SelfHostedResponseContract {
  readonly method: string;
  readonly operationId: string;
  readonly path: string;
  readonly status: number;
  readonly schema: unknown;
}

export const SELF_HOSTED_RESPONSE_CONTRACTS: readonly SelfHostedResponseContract[] = [
  {
    "method": "GET",
    "operationId": "getHealth",
    "path": "/health",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "ok"
          ]
        },
        "version": {
          "type": "string"
        },
        "mode": {
          "type": "string",
          "enum": [
            "self_hosted"
          ]
        },
        "name": {
          "type": "string",
          "enum": [
            "emails"
          ]
        },
        "db": {
          "type": "object",
          "properties": {
            "ok": {
              "type": "boolean"
            },
            "latencyMs": {
              "type": "number",
              "minimum": 0
            }
          },
          "required": [
            "ok",
            "latencyMs"
          ]
        }
      },
      "required": [
        "status",
        "version",
        "mode",
        "name",
        "db"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getOpenApiDocument",
    "path": "/openapi.json",
    "status": 200,
    "schema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "openapi": {
          "type": "string"
        },
        "info": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "title": {
              "type": "string"
            },
            "version": {
              "type": "string"
            }
          },
          "required": [
            "title",
            "version"
          ]
        },
        "security": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "paths": {
          "type": "object",
          "additionalProperties": true
        },
        "components": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "required": [
        "openapi",
        "info",
        "security",
        "paths",
        "components"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getReady",
    "path": "/ready",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "ready"
          ]
        },
        "version": {
          "type": "string"
        },
        "mode": {
          "type": "string",
          "enum": [
            "self_hosted"
          ]
        },
        "db": {
          "type": "object",
          "properties": {
            "ok": {
              "type": "boolean",
              "enum": [
                true
              ]
            },
            "latencyMs": {
              "type": "number",
              "minimum": 0
            }
          },
          "required": [
            "ok",
            "latencyMs"
          ]
        },
        "pendingMigrations": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "migrationIssues": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "status",
        "version",
        "mode",
        "db",
        "pendingMigrations",
        "migrationIssues"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getReady",
    "path": "/ready",
    "status": 503,
    "schema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "not_ready"
          ]
        },
        "version": {
          "type": "string"
        },
        "mode": {
          "type": "string",
          "enum": [
            "self_hosted"
          ]
        },
        "db": {
          "type": "object",
          "properties": {
            "ok": {
              "type": "boolean",
              "enum": [
                false
              ]
            },
            "latencyMs": {
              "type": "number",
              "minimum": 0
            }
          },
          "required": [
            "ok",
            "latencyMs"
          ]
        },
        "pendingMigrations": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "migrationIssues": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "status",
        "version",
        "mode",
        "db",
        "pendingMigrations",
        "migrationIssues"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped address-ownership-events row.",
            "properties": {
              "id": {
                "type": "string"
              },
              "address_id": {
                "type": "string",
                "nullable": true
              },
              "action": {
                "type": "string",
                "nullable": true
              },
              "previous_owner_id": {
                "type": "string",
                "nullable": true
              },
              "previous_administrator_id": {
                "type": "string",
                "nullable": true
              },
              "owner_id": {
                "type": "string",
                "nullable": true
              },
              "administrator_id": {
                "type": "string",
                "nullable": true
              },
              "actor": {
                "type": "string",
                "nullable": true
              },
              "reason": {
                "type": "string",
                "nullable": true
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "address_id",
              "action",
              "previous_owner_id",
              "previous_administrator_id",
              "owner_id",
              "administrator_id",
              "actor",
              "reason",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped address-ownership-events row.",
      "properties": {
        "id": {
          "type": "string"
        },
        "address_id": {
          "type": "string",
          "nullable": true
        },
        "action": {
          "type": "string",
          "nullable": true
        },
        "previous_owner_id": {
          "type": "string",
          "nullable": true
        },
        "previous_administrator_id": {
          "type": "string",
          "nullable": true
        },
        "owner_id": {
          "type": "string",
          "nullable": true
        },
        "administrator_id": {
          "type": "string",
          "nullable": true
        },
        "actor": {
          "type": "string",
          "nullable": true
        },
        "reason": {
          "type": "string",
          "nullable": true
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "address_id",
        "action",
        "previous_owner_id",
        "previous_administrator_id",
        "owner_id",
        "administrator_id",
        "actor",
        "reason",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "cross_tenant_reference"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "address-ownership-events not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped address-ownership-events row.",
      "properties": {
        "id": {
          "type": "string"
        },
        "address_id": {
          "type": "string",
          "nullable": true
        },
        "action": {
          "type": "string",
          "nullable": true
        },
        "previous_owner_id": {
          "type": "string",
          "nullable": true
        },
        "previous_administrator_id": {
          "type": "string",
          "nullable": true
        },
        "owner_id": {
          "type": "string",
          "nullable": true
        },
        "administrator_id": {
          "type": "string",
          "nullable": true
        },
        "actor": {
          "type": "string",
          "nullable": true
        },
        "reason": {
          "type": "string",
          "nullable": true
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "address_id",
        "action",
        "previous_owner_id",
        "previous_administrator_id",
        "owner_id",
        "administrator_id",
        "actor",
        "reason",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "address-ownership-events not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped address-ownership-events row.",
      "properties": {
        "id": {
          "type": "string"
        },
        "address_id": {
          "type": "string",
          "nullable": true
        },
        "action": {
          "type": "string",
          "nullable": true
        },
        "previous_owner_id": {
          "type": "string",
          "nullable": true
        },
        "previous_administrator_id": {
          "type": "string",
          "nullable": true
        },
        "owner_id": {
          "type": "string",
          "nullable": true
        },
        "administrator_id": {
          "type": "string",
          "nullable": true
        },
        "actor": {
          "type": "string",
          "nullable": true
        },
        "reason": {
          "type": "string",
          "nullable": true
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "address_id",
        "action",
        "previous_owner_id",
        "previous_administrator_id",
        "owner_id",
        "administrator_id",
        "actor",
        "reason",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "address-ownership-events not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped address-ownership-events row.",
      "properties": {
        "id": {
          "type": "string"
        },
        "address_id": {
          "type": "string",
          "nullable": true
        },
        "action": {
          "type": "string",
          "nullable": true
        },
        "previous_owner_id": {
          "type": "string",
          "nullable": true
        },
        "previous_administrator_id": {
          "type": "string",
          "nullable": true
        },
        "owner_id": {
          "type": "string",
          "nullable": true
        },
        "administrator_id": {
          "type": "string",
          "nullable": true
        },
        "actor": {
          "type": "string",
          "nullable": true
        },
        "reason": {
          "type": "string",
          "nullable": true
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "address_id",
        "action",
        "previous_owner_id",
        "previous_administrator_id",
        "owner_id",
        "administrator_id",
        "actor",
        "reason",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "address-ownership-events not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAddressOwnershipEvents",
    "path": "/v1/address-ownership-events/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listAddresses",
    "path": "/v1/addresses",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "addresses": {
          "type": "array",
          "items": {
            "$ref": "#/components/schemas/Address"
          }
        }
      },
      "required": [
        "addresses"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listAddresses",
    "path": "/v1/addresses",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listAddresses",
    "path": "/v1/addresses",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listAddresses",
    "path": "/v1/addresses",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createAddress",
    "path": "/v1/addresses",
    "status": 201,
    "schema": {
      "type": "object",
      "properties": {
        "address": {
          "$ref": "#/components/schemas/Address"
        }
      },
      "required": [
        "address"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createAddress",
    "path": "/v1/addresses",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createAddress",
    "path": "/v1/addresses",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createAddress",
    "path": "/v1/addresses",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createAddress",
    "path": "/v1/addresses",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createAddress",
    "path": "/v1/addresses",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteAddress",
    "path": "/v1/addresses/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteAddress",
    "path": "/v1/addresses/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteAddress",
    "path": "/v1/addresses/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteAddress",
    "path": "/v1/addresses/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "address not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteAddress",
    "path": "/v1/addresses/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getAddress",
    "path": "/v1/addresses/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "address": {
          "$ref": "#/components/schemas/Address"
        }
      },
      "required": [
        "address"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getAddress",
    "path": "/v1/addresses/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getAddress",
    "path": "/v1/addresses/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getAddress",
    "path": "/v1/addresses/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "address not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getAddress",
    "path": "/v1/addresses/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateAddress",
    "path": "/v1/addresses/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "address": {
          "$ref": "#/components/schemas/Address"
        }
      },
      "required": [
        "address"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateAddress",
    "path": "/v1/addresses/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateAddress",
    "path": "/v1/addresses/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateAddress",
    "path": "/v1/addresses/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateAddress",
    "path": "/v1/addresses/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "address not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateAddress",
    "path": "/v1/addresses/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateAddress",
    "path": "/v1/addresses/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceAddress",
    "path": "/v1/addresses/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "address": {
          "$ref": "#/components/schemas/Address"
        }
      },
      "required": [
        "address"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceAddress",
    "path": "/v1/addresses/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceAddress",
    "path": "/v1/addresses/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceAddress",
    "path": "/v1/addresses/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceAddress",
    "path": "/v1/addresses/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "address not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceAddress",
    "path": "/v1/addresses/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceAddress",
    "path": "/v1/addresses/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceAliases",
    "path": "/v1/aliases",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped aliases row.",
            "properties": {
              "domain": {
                "type": "string",
                "nullable": true
              },
              "local_part": {
                "type": "string",
                "nullable": true
              },
              "target_address": {
                "type": "string",
                "nullable": true
              },
              "protected": {
                "type": "boolean"
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "domain",
              "local_part",
              "target_address",
              "protected",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceAliases",
    "path": "/v1/aliases",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceAliases",
    "path": "/v1/aliases",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceAliases",
    "path": "/v1/aliases",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAliases",
    "path": "/v1/aliases",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped aliases row.",
      "properties": {
        "domain": {
          "type": "string",
          "nullable": true
        },
        "local_part": {
          "type": "string",
          "nullable": true
        },
        "target_address": {
          "type": "string",
          "nullable": true
        },
        "protected": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "domain",
        "local_part",
        "target_address",
        "protected",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAliases",
    "path": "/v1/aliases",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAliases",
    "path": "/v1/aliases",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAliases",
    "path": "/v1/aliases",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAliases",
    "path": "/v1/aliases",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceAliases",
    "path": "/v1/aliases",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "aliases not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped aliases row.",
      "properties": {
        "domain": {
          "type": "string",
          "nullable": true
        },
        "local_part": {
          "type": "string",
          "nullable": true
        },
        "target_address": {
          "type": "string",
          "nullable": true
        },
        "protected": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "domain",
        "local_part",
        "target_address",
        "protected",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "aliases not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped aliases row.",
      "properties": {
        "domain": {
          "type": "string",
          "nullable": true
        },
        "local_part": {
          "type": "string",
          "nullable": true
        },
        "target_address": {
          "type": "string",
          "nullable": true
        },
        "protected": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "domain",
        "local_part",
        "target_address",
        "protected",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "aliases not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped aliases row.",
      "properties": {
        "domain": {
          "type": "string",
          "nullable": true
        },
        "local_part": {
          "type": "string",
          "nullable": true
        },
        "target_address": {
          "type": "string",
          "nullable": true
        },
        "protected": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "domain",
        "local_part",
        "target_address",
        "protected",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "aliases not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceAliases",
    "path": "/v1/aliases/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listAttachments",
    "path": "/v1/attachments",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/components/schemas/AttachmentInventoryItem"
          }
        },
        "next_cursor": {
          "type": "string",
          "nullable": true,
          "description": "Cursor for the next page; null when this page is the last."
        }
      },
      "required": [
        "items",
        "next_cursor"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listAttachments",
    "path": "/v1/attachments",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string"
        },
        "code": {
          "type": "string",
          "enum": [
            "invalid_cursor",
            "invalid_direction",
            "invalid_since",
            "invalid_limit"
          ]
        }
      },
      "required": [
        "error",
        "code"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listAttachments",
    "path": "/v1/attachments",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listAttachments",
    "path": "/v1/attachments",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listAttachments",
    "path": "/v1/attachments",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "batchAttachments",
    "path": "/v1/attachments/batch",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "by_message_id": {
          "type": "object",
          "additionalProperties": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/AttachmentBatchMeta"
            }
          },
          "description": "Attachment metadata keyed by message_id (only ids resolvable in this tenant)."
        },
        "unknown_ids": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Requested ids not found in this tenant (nonexistent or foreign)."
        },
        "max_batch_size": {
          "type": "integer"
        }
      },
      "required": [
        "by_message_id",
        "unknown_ids",
        "max_batch_size"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "batchAttachments",
    "path": "/v1/attachments/batch",
    "status": 400,
    "schema": {
      "anyOf": [
        {
          "$ref": "#/components/schemas/ErrorResponse"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "error"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "batchAttachments",
    "path": "/v1/attachments/batch",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "batchAttachments",
    "path": "/v1/attachments/batch",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "batchAttachments",
    "path": "/v1/attachments/batch",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "batchAttachments",
    "path": "/v1/attachments/batch",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createOrResumeAttachmentRepair",
    "path": "/v1/attachments/repairs",
    "status": 201,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "repair": {
          "$ref": "#/components/schemas/AttachmentRepairSummary"
        },
        "max_page_size": {
          "type": "integer",
          "enum": [
            25
          ]
        }
      },
      "required": [
        "repair",
        "max_page_size"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createOrResumeAttachmentRepair",
    "path": "/v1/attachments/repairs",
    "status": 400,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string"
            },
            "code": {
              "type": "string",
              "enum": [
                "invalid_idempotency_key",
                "invalid_apply",
                "invalid_repair_manifest",
                "invalid_repair_limit",
                "invalid_repair_body",
                "invalid_repair_review"
              ]
            }
          },
          "required": [
            "error",
            "code"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "error"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createOrResumeAttachmentRepair",
    "path": "/v1/attachments/repairs",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createOrResumeAttachmentRepair",
    "path": "/v1/attachments/repairs",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createOrResumeAttachmentRepair",
    "path": "/v1/attachments/repairs",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string"
        },
        "code": {
          "type": "string",
          "enum": [
            "attachment_repair_idempotency_conflict",
            "attachment_repair_review_mismatch"
          ]
        }
      },
      "required": [
        "error",
        "code"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createOrResumeAttachmentRepair",
    "path": "/v1/attachments/repairs",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createOrResumeAttachmentRepair",
    "path": "/v1/attachments/repairs",
    "status": 429,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string"
        },
        "code": {
          "type": "string",
          "enum": [
            "attachment_repair_quota_exceeded"
          ]
        },
        "quota": {
          "type": "string",
          "enum": [
            "active_runs",
            "ledger_runs",
            "ledger_entries"
          ]
        },
        "retryable": {
          "type": "boolean"
        }
      },
      "required": [
        "error",
        "code",
        "quota",
        "retryable"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createOrResumeAttachmentRepair",
    "path": "/v1/attachments/repairs",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createOrResumeAttachmentRepair",
    "path": "/v1/attachments/repairs",
    "status": 503,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string"
        },
        "code": {
          "type": "string",
          "enum": [
            "attachment_repair_not_configured"
          ]
        }
      },
      "required": [
        "error",
        "code"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "repair": {
          "$ref": "#/components/schemas/AttachmentRepairSummary"
        }
      },
      "required": [
        "repair"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string"
        },
        "code": {
          "type": "string",
          "enum": [
            "invalid_attachment_repair_id"
          ]
        }
      },
      "required": [
        "error",
        "code"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}",
    "status": 404,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "GET",
    "operationId": "getAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resumeAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}/resume",
    "status": 200,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "repair": {
          "$ref": "#/components/schemas/AttachmentRepairSummary"
        },
        "max_page_size": {
          "type": "integer",
          "enum": [
            25
          ]
        }
      },
      "required": [
        "repair",
        "max_page_size"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resumeAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}/resume",
    "status": 400,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string"
            },
            "code": {
              "type": "string",
              "enum": [
                "invalid_attachment_repair_id",
                "invalid_repair_limit",
                "invalid_repair_body"
              ]
            }
          },
          "required": [
            "error",
            "code"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "error"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resumeAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}/resume",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resumeAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}/resume",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resumeAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}/resume",
    "status": 404,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "POST",
    "operationId": "resumeAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}/resume",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resumeAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}/resume",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resumeAttachmentRepair",
    "path": "/v1/attachments/repairs/{id}/resume",
    "status": 503,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string"
        },
        "code": {
          "type": "string",
          "enum": [
            "attachment_repair_not_configured"
          ]
        }
      },
      "required": [
        "error",
        "code"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapOwner",
    "path": "/v1/auth/bootstrap-owner",
    "status": 201,
    "schema": {
      "type": "object",
      "properties": {
        "user": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "email": {
              "type": "string",
              "format": "email"
            },
            "name": {
              "type": "string",
              "nullable": true
            },
            "status": {
              "type": "string"
            },
            "email_verified": {
              "type": "boolean"
            },
            "global_role": {
              "type": "string",
              "enum": [
                "user",
                "super_admin"
              ]
            },
            "is_primary_super_admin": {
              "type": "boolean"
            },
            "created_at": {
              "type": "string",
              "format": "date-time"
            }
          },
          "required": [
            "id",
            "email",
            "name",
            "status",
            "email_verified",
            "created_at"
          ]
        },
        "tenant": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "slug": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "status": {
              "type": "string"
            }
          },
          "required": [
            "id",
            "slug",
            "name",
            "status"
          ],
          "nullable": true
        }
      },
      "required": [
        "user",
        "tenant"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapOwner",
    "path": "/v1/auth/bootstrap-owner",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapOwner",
    "path": "/v1/auth/bootstrap-owner",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapOwner",
    "path": "/v1/auth/bootstrap-owner",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapOwner",
    "path": "/v1/auth/bootstrap-owner",
    "status": 409,
    "schema": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "this tenant already has an owner"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "owner_exists"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        },
        {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "an account with that email already exists"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "email_taken"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapOwner",
    "path": "/v1/auth/bootstrap-owner",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapOwner",
    "path": "/v1/auth/bootstrap-owner",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapPrimarySuperAdmin",
    "path": "/v1/auth/bootstrap-super-admin",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "created": {
          "type": "boolean"
        },
        "user": {
          "$ref": "#/components/schemas/User"
        },
        "tenant": {
          "$ref": "#/components/schemas/Tenant",
          "nullable": true
        }
      },
      "required": [
        "created",
        "user",
        "tenant"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapPrimarySuperAdmin",
    "path": "/v1/auth/bootstrap-super-admin",
    "status": 201,
    "schema": {
      "type": "object",
      "properties": {
        "created": {
          "type": "boolean"
        },
        "user": {
          "$ref": "#/components/schemas/User"
        },
        "tenant": {
          "$ref": "#/components/schemas/Tenant",
          "nullable": true
        }
      },
      "required": [
        "created",
        "user",
        "tenant"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapPrimarySuperAdmin",
    "path": "/v1/auth/bootstrap-super-admin",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapPrimarySuperAdmin",
    "path": "/v1/auth/bootstrap-super-admin",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapPrimarySuperAdmin",
    "path": "/v1/auth/bootstrap-super-admin",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapPrimarySuperAdmin",
    "path": "/v1/auth/bootstrap-super-admin",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapPrimarySuperAdmin",
    "path": "/v1/auth/bootstrap-super-admin",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapPrimarySuperAdmin",
    "path": "/v1/auth/bootstrap-super-admin",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "bootstrapPrimarySuperAdmin",
    "path": "/v1/auth/bootstrap-super-admin",
    "status": 503,
    "schema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "primary super-admin bootstrap is not configured"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "bootstrap_not_configured"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logIn",
    "path": "/v1/auth/login",
    "status": 200,
    "schema": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "needs_tenant": {
              "type": "boolean",
              "enum": [
                true
              ]
            },
            "tenants": {
              "type": "array",
              "minItems": 2,
              "items": {
                "$ref": "#/components/schemas/TenantChoice"
              }
            }
          },
          "required": [
            "needs_tenant",
            "tenants"
          ]
        },
        {
          "type": "object",
          "properties": {
            "session_token": {
              "type": "string"
            },
            "expires_at": {
              "type": "string",
              "format": "date-time"
            },
            "user": {
              "type": "object",
              "additionalProperties": true,
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1
                },
                "email": {
                  "type": "string",
                  "format": "email"
                },
                "name": {
                  "type": "string",
                  "nullable": true
                },
                "status": {
                  "type": "string"
                },
                "email_verified": {
                  "type": "boolean"
                },
                "global_role": {
                  "type": "string",
                  "enum": [
                    "user",
                    "super_admin"
                  ]
                },
                "is_primary_super_admin": {
                  "type": "boolean"
                },
                "created_at": {
                  "type": "string",
                  "format": "date-time"
                }
              },
              "required": [
                "id",
                "email",
                "name",
                "status",
                "email_verified",
                "created_at"
              ]
            },
            "tenant": {
              "type": "object",
              "additionalProperties": true,
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1
                },
                "slug": {
                  "type": "string"
                },
                "name": {
                  "type": "string"
                },
                "status": {
                  "type": "string"
                }
              },
              "required": [
                "id",
                "slug",
                "name",
                "status"
              ]
            },
            "role": {
              "type": "string",
              "enum": [
                "owner",
                "admin",
                "member",
                "viewer"
              ]
            }
          },
          "required": [
            "session_token",
            "expires_at",
            "user",
            "tenant",
            "role"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logIn",
    "path": "/v1/auth/login",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logIn",
    "path": "/v1/auth/login",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "invalid email or password"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "invalid_credentials"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logIn",
    "path": "/v1/auth/login",
    "status": 403,
    "schema": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "login is restricted"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "email_not_allowed"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        },
        {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "email is not verified"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "email_unverified"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "your account is not a member of any organization"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "no_tenant"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        },
        {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "you are not a member of that organization"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "not_a_member"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logIn",
    "path": "/v1/auth/login",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logIn",
    "path": "/v1/auth/login",
    "status": 429,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "too many requests"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "rate_limited"
              ]
            },
            "retry_after": {
              "type": "number",
              "minimum": 0
            }
          },
          "required": [
            "error",
            "reason",
            "retry_after"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "too many attempts; try again later"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "locked"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logIn",
    "path": "/v1/auth/login",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logOut",
    "path": "/v1/auth/logout",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "logged_out": {
          "type": "boolean",
          "enum": [
            true
          ]
        }
      },
      "required": [
        "logged_out"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logOut",
    "path": "/v1/auth/logout",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "not a session"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "not_session"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logOut",
    "path": "/v1/auth/logout",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logOut",
    "path": "/v1/auth/logout",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logOut",
    "path": "/v1/auth/logout",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logOutAll",
    "path": "/v1/auth/logout-all",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "logged_out": {
          "type": "boolean",
          "enum": [
            true
          ]
        }
      },
      "required": [
        "logged_out"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logOutAll",
    "path": "/v1/auth/logout-all",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "not a session"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "not_session"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logOutAll",
    "path": "/v1/auth/logout-all",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logOutAll",
    "path": "/v1/auth/logout-all",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "logOutAll",
    "path": "/v1/auth/logout-all",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "requestPasswordReset",
    "path": "/v1/auth/password/forgot",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "reset_requested"
          ]
        }
      },
      "required": [
        "status"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "requestPasswordReset",
    "path": "/v1/auth/password/forgot",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "requestPasswordReset",
    "path": "/v1/auth/password/forgot",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "requestPasswordReset",
    "path": "/v1/auth/password/forgot",
    "status": 429,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "too many requests"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "rate_limited"
          ]
        },
        "retry_after": {
          "type": "number",
          "minimum": 0
        }
      },
      "required": [
        "error",
        "reason",
        "retry_after"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "requestPasswordReset",
    "path": "/v1/auth/password/forgot",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resetPassword",
    "path": "/v1/auth/password/reset",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "reset": {
          "type": "boolean",
          "enum": [
            true
          ]
        }
      },
      "required": [
        "reset"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resetPassword",
    "path": "/v1/auth/password/reset",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resetPassword",
    "path": "/v1/auth/password/reset",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resetPassword",
    "path": "/v1/auth/password/reset",
    "status": 429,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "too many requests"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "rate_limited"
          ]
        },
        "retry_after": {
          "type": "number",
          "minimum": 0
        }
      },
      "required": [
        "error",
        "reason",
        "retry_after"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resetPassword",
    "path": "/v1/auth/password/reset",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listAuthProviders",
    "path": "/v1/auth/providers",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "google": {
          "type": "boolean",
          "enum": [
            false
          ]
        },
        "device": {
          "type": "boolean",
          "enum": [
            false
          ]
        }
      },
      "required": [
        "google",
        "device"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "signUp",
    "path": "/v1/auth/signup",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "verification_required"
          ]
        },
        "email": {
          "type": "string",
          "format": "email"
        },
        "verification_required": {
          "type": "boolean",
          "enum": [
            true
          ]
        }
      },
      "required": [
        "status",
        "email",
        "verification_required"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "signUp",
    "path": "/v1/auth/signup",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "signUp",
    "path": "/v1/auth/signup",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "signups are restricted"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "email_not_allowed"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "signUp",
    "path": "/v1/auth/signup",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "signUp",
    "path": "/v1/auth/signup",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "signUp",
    "path": "/v1/auth/signup",
    "status": 429,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "too many requests"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "rate_limited"
          ]
        },
        "retry_after": {
          "type": "number",
          "minimum": 0
        }
      },
      "required": [
        "error",
        "reason",
        "retry_after"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "signUp",
    "path": "/v1/auth/signup",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "switchTenant",
    "path": "/v1/auth/switch-tenant",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "session_token": {
          "type": "string"
        },
        "expires_at": {
          "type": "string",
          "format": "date-time"
        },
        "tenant": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "slug": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "status": {
              "type": "string"
            }
          },
          "required": [
            "id",
            "slug",
            "name",
            "status"
          ]
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "admin",
            "member",
            "viewer"
          ]
        }
      },
      "required": [
        "session_token",
        "expires_at",
        "tenant",
        "role"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "switchTenant",
    "path": "/v1/auth/switch-tenant",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "switchTenant",
    "path": "/v1/auth/switch-tenant",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "switchTenant",
    "path": "/v1/auth/switch-tenant",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "switchTenant",
    "path": "/v1/auth/switch-tenant",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "organization not found"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "not_found"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "switchTenant",
    "path": "/v1/auth/switch-tenant",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "switchTenant",
    "path": "/v1/auth/switch-tenant",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "verifyEmailLink",
    "path": "/v1/auth/verify-email",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "verified": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "user": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "email": {
              "type": "string",
              "format": "email"
            },
            "name": {
              "type": "string",
              "nullable": true
            },
            "status": {
              "type": "string"
            },
            "email_verified": {
              "type": "boolean"
            },
            "global_role": {
              "type": "string",
              "enum": [
                "user",
                "super_admin"
              ]
            },
            "is_primary_super_admin": {
              "type": "boolean"
            },
            "created_at": {
              "type": "string",
              "format": "date-time"
            }
          },
          "required": [
            "id",
            "email",
            "name",
            "status",
            "email_verified",
            "created_at"
          ]
        }
      },
      "required": [
        "verified",
        "user"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "verifyEmailLink",
    "path": "/v1/auth/verify-email",
    "status": 400,
    "schema": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "token is required"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "verification link is invalid or expired"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "invalid_token"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "verifyEmailLink",
    "path": "/v1/auth/verify-email",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "verifyEmailToken",
    "path": "/v1/auth/verify-email",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "verified": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "user": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "email": {
              "type": "string",
              "format": "email"
            },
            "name": {
              "type": "string",
              "nullable": true
            },
            "status": {
              "type": "string"
            },
            "email_verified": {
              "type": "boolean"
            },
            "global_role": {
              "type": "string",
              "enum": [
                "user",
                "super_admin"
              ]
            },
            "is_primary_super_admin": {
              "type": "boolean"
            },
            "created_at": {
              "type": "string",
              "format": "date-time"
            }
          },
          "required": [
            "id",
            "email",
            "name",
            "status",
            "email_verified",
            "created_at"
          ]
        }
      },
      "required": [
        "verified",
        "user"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "verifyEmailToken",
    "path": "/v1/auth/verify-email",
    "status": 400,
    "schema": {
      "anyOf": [
        {
          "oneOf": [
            {
              "type": "object",
              "additionalProperties": true,
              "properties": {
                "error": {
                  "type": "string",
                  "enum": [
                    "token is required"
                  ]
                }
              },
              "required": [
                "error"
              ]
            },
            {
              "type": "object",
              "additionalProperties": true,
              "properties": {
                "error": {
                  "type": "string",
                  "enum": [
                    "verification link is invalid or expired"
                  ]
                },
                "reason": {
                  "type": "string",
                  "enum": [
                    "invalid_token"
                  ]
                }
              },
              "required": [
                "error",
                "reason"
              ]
            }
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "error"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "verifyEmailToken",
    "path": "/v1/auth/verify-email",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "verifyEmailToken",
    "path": "/v1/auth/verify-email",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resendEmailVerification",
    "path": "/v1/auth/verify-email/resend",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "verification_required"
          ]
        },
        "verification_required": {
          "type": "boolean",
          "enum": [
            true
          ]
        }
      },
      "required": [
        "status",
        "verification_required"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resendEmailVerification",
    "path": "/v1/auth/verify-email/resend",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resendEmailVerification",
    "path": "/v1/auth/verify-email/resend",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resendEmailVerification",
    "path": "/v1/auth/verify-email/resend",
    "status": 429,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "too many requests"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "rate_limited"
          ]
        },
        "retry_after": {
          "type": "number",
          "minimum": 0
        }
      },
      "required": [
        "error",
        "reason",
        "retry_after"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "resendEmailVerification",
    "path": "/v1/auth/verify-email/resend",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceContacts",
    "path": "/v1/contacts",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped contacts row.",
            "properties": {
              "email": {
                "type": "string",
                "nullable": true
              },
              "name": {
                "type": "string",
                "nullable": true
              },
              "send_count": {
                "type": "integer"
              },
              "bounce_count": {
                "type": "integer"
              },
              "complaint_count": {
                "type": "integer"
              },
              "last_sent_at": {
                "type": "string",
                "nullable": true
              },
              "suppressed": {
                "type": "boolean"
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "email",
              "name",
              "send_count",
              "bounce_count",
              "complaint_count",
              "last_sent_at",
              "suppressed",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceContacts",
    "path": "/v1/contacts",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceContacts",
    "path": "/v1/contacts",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceContacts",
    "path": "/v1/contacts",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceContacts",
    "path": "/v1/contacts",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped contacts row.",
      "properties": {
        "email": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "send_count": {
          "type": "integer"
        },
        "bounce_count": {
          "type": "integer"
        },
        "complaint_count": {
          "type": "integer"
        },
        "last_sent_at": {
          "type": "string",
          "nullable": true
        },
        "suppressed": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "email",
        "name",
        "send_count",
        "bounce_count",
        "complaint_count",
        "last_sent_at",
        "suppressed",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceContacts",
    "path": "/v1/contacts",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceContacts",
    "path": "/v1/contacts",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceContacts",
    "path": "/v1/contacts",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceContacts",
    "path": "/v1/contacts",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceContacts",
    "path": "/v1/contacts",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "contacts not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped contacts row.",
      "properties": {
        "email": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "send_count": {
          "type": "integer"
        },
        "bounce_count": {
          "type": "integer"
        },
        "complaint_count": {
          "type": "integer"
        },
        "last_sent_at": {
          "type": "string",
          "nullable": true
        },
        "suppressed": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "email",
        "name",
        "send_count",
        "bounce_count",
        "complaint_count",
        "last_sent_at",
        "suppressed",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "contacts not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped contacts row.",
      "properties": {
        "email": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "send_count": {
          "type": "integer"
        },
        "bounce_count": {
          "type": "integer"
        },
        "complaint_count": {
          "type": "integer"
        },
        "last_sent_at": {
          "type": "string",
          "nullable": true
        },
        "suppressed": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "email",
        "name",
        "send_count",
        "bounce_count",
        "complaint_count",
        "last_sent_at",
        "suppressed",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "contacts not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped contacts row.",
      "properties": {
        "email": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "send_count": {
          "type": "integer"
        },
        "bounce_count": {
          "type": "integer"
        },
        "complaint_count": {
          "type": "integer"
        },
        "last_sent_at": {
          "type": "string",
          "nullable": true
        },
        "suppressed": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "email",
        "name",
        "send_count",
        "bounce_count",
        "complaint_count",
        "last_sent_at",
        "suppressed",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "contacts not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceContacts",
    "path": "/v1/contacts/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listDomains",
    "path": "/v1/domains",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "domains": {
          "type": "array",
          "items": {
            "$ref": "#/components/schemas/Domain"
          }
        }
      },
      "required": [
        "domains"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listDomains",
    "path": "/v1/domains",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listDomains",
    "path": "/v1/domains",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listDomains",
    "path": "/v1/domains",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createDomain",
    "path": "/v1/domains",
    "status": 201,
    "schema": {
      "type": "object",
      "properties": {
        "domain": {
          "$ref": "#/components/schemas/Domain"
        }
      },
      "required": [
        "domain"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createDomain",
    "path": "/v1/domains",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createDomain",
    "path": "/v1/domains",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createDomain",
    "path": "/v1/domains",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createDomain",
    "path": "/v1/domains",
    "status": 409,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "inbound domain route is already claimed"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "inbound_route_conflict"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createDomain",
    "path": "/v1/domains",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createDomain",
    "path": "/v1/domains",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteDomain",
    "path": "/v1/domains/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteDomain",
    "path": "/v1/domains/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteDomain",
    "path": "/v1/domains/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteDomain",
    "path": "/v1/domains/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "domain not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteDomain",
    "path": "/v1/domains/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getDomain",
    "path": "/v1/domains/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "domain": {
          "$ref": "#/components/schemas/Domain"
        }
      },
      "required": [
        "domain"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getDomain",
    "path": "/v1/domains/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getDomain",
    "path": "/v1/domains/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getDomain",
    "path": "/v1/domains/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "domain not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getDomain",
    "path": "/v1/domains/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateDomain",
    "path": "/v1/domains/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "domain": {
          "$ref": "#/components/schemas/Domain"
        }
      },
      "required": [
        "domain"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateDomain",
    "path": "/v1/domains/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateDomain",
    "path": "/v1/domains/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateDomain",
    "path": "/v1/domains/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateDomain",
    "path": "/v1/domains/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "domain not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateDomain",
    "path": "/v1/domains/{id}",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "inbound domain route is already claimed"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "inbound_route_conflict"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateDomain",
    "path": "/v1/domains/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateDomain",
    "path": "/v1/domains/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceDomain",
    "path": "/v1/domains/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "domain": {
          "$ref": "#/components/schemas/Domain"
        }
      },
      "required": [
        "domain"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceDomain",
    "path": "/v1/domains/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceDomain",
    "path": "/v1/domains/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceDomain",
    "path": "/v1/domains/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceDomain",
    "path": "/v1/domains/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "domain not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceDomain",
    "path": "/v1/domains/{id}",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "inbound domain route is already claimed"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "inbound_route_conflict"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceDomain",
    "path": "/v1/domains/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceDomain",
    "path": "/v1/domains/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped email-agent-runs row.",
            "properties": {
              "agent_key": {
                "type": "string",
                "nullable": true
              },
              "inbound_email_id": {
                "type": "string",
                "nullable": true
              },
              "provider": {
                "type": "string",
                "nullable": true
              },
              "model": {
                "type": "string",
                "nullable": true
              },
              "status": {
                "type": "string",
                "nullable": true
              },
              "category": {
                "type": "string",
                "nullable": true
              },
              "labels_json": {},
              "priority": {
                "type": "integer"
              },
              "confidence": {
                "type": "number"
              },
              "risk_score": {
                "type": "integer"
              },
              "summary": {
                "type": "string",
                "nullable": true
              },
              "reasoning": {
                "type": "string",
                "nullable": true
              },
              "tool_calls_json": {},
              "output_json": {},
              "error": {
                "type": "string",
                "nullable": true
              },
              "started_at": {
                "type": "string",
                "nullable": true
              },
              "completed_at": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "agent_key",
              "inbound_email_id",
              "provider",
              "model",
              "status",
              "category",
              "labels_json",
              "priority",
              "confidence",
              "risk_score",
              "summary",
              "reasoning",
              "tool_calls_json",
              "output_json",
              "error",
              "started_at",
              "completed_at",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped email-agent-runs row.",
      "properties": {
        "agent_key": {
          "type": "string",
          "nullable": true
        },
        "inbound_email_id": {
          "type": "string",
          "nullable": true
        },
        "provider": {
          "type": "string",
          "nullable": true
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "category": {
          "type": "string",
          "nullable": true
        },
        "labels_json": {},
        "priority": {
          "type": "integer"
        },
        "confidence": {
          "type": "number"
        },
        "risk_score": {
          "type": "integer"
        },
        "summary": {
          "type": "string",
          "nullable": true
        },
        "reasoning": {
          "type": "string",
          "nullable": true
        },
        "tool_calls_json": {},
        "output_json": {},
        "error": {
          "type": "string",
          "nullable": true
        },
        "started_at": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "agent_key",
        "inbound_email_id",
        "provider",
        "model",
        "status",
        "category",
        "labels_json",
        "priority",
        "confidence",
        "risk_score",
        "summary",
        "reasoning",
        "tool_calls_json",
        "output_json",
        "error",
        "started_at",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "email-agent-runs not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped email-agent-runs row.",
      "properties": {
        "agent_key": {
          "type": "string",
          "nullable": true
        },
        "inbound_email_id": {
          "type": "string",
          "nullable": true
        },
        "provider": {
          "type": "string",
          "nullable": true
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "category": {
          "type": "string",
          "nullable": true
        },
        "labels_json": {},
        "priority": {
          "type": "integer"
        },
        "confidence": {
          "type": "number"
        },
        "risk_score": {
          "type": "integer"
        },
        "summary": {
          "type": "string",
          "nullable": true
        },
        "reasoning": {
          "type": "string",
          "nullable": true
        },
        "tool_calls_json": {},
        "output_json": {},
        "error": {
          "type": "string",
          "nullable": true
        },
        "started_at": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "agent_key",
        "inbound_email_id",
        "provider",
        "model",
        "status",
        "category",
        "labels_json",
        "priority",
        "confidence",
        "risk_score",
        "summary",
        "reasoning",
        "tool_calls_json",
        "output_json",
        "error",
        "started_at",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "email-agent-runs not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped email-agent-runs row.",
      "properties": {
        "agent_key": {
          "type": "string",
          "nullable": true
        },
        "inbound_email_id": {
          "type": "string",
          "nullable": true
        },
        "provider": {
          "type": "string",
          "nullable": true
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "category": {
          "type": "string",
          "nullable": true
        },
        "labels_json": {},
        "priority": {
          "type": "integer"
        },
        "confidence": {
          "type": "number"
        },
        "risk_score": {
          "type": "integer"
        },
        "summary": {
          "type": "string",
          "nullable": true
        },
        "reasoning": {
          "type": "string",
          "nullable": true
        },
        "tool_calls_json": {},
        "output_json": {},
        "error": {
          "type": "string",
          "nullable": true
        },
        "started_at": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "agent_key",
        "inbound_email_id",
        "provider",
        "model",
        "status",
        "category",
        "labels_json",
        "priority",
        "confidence",
        "risk_score",
        "summary",
        "reasoning",
        "tool_calls_json",
        "output_json",
        "error",
        "started_at",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "email-agent-runs not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped email-agent-runs row.",
      "properties": {
        "agent_key": {
          "type": "string",
          "nullable": true
        },
        "inbound_email_id": {
          "type": "string",
          "nullable": true
        },
        "provider": {
          "type": "string",
          "nullable": true
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "category": {
          "type": "string",
          "nullable": true
        },
        "labels_json": {},
        "priority": {
          "type": "integer"
        },
        "confidence": {
          "type": "number"
        },
        "risk_score": {
          "type": "integer"
        },
        "summary": {
          "type": "string",
          "nullable": true
        },
        "reasoning": {
          "type": "string",
          "nullable": true
        },
        "tool_calls_json": {},
        "output_json": {},
        "error": {
          "type": "string",
          "nullable": true
        },
        "started_at": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "agent_key",
        "inbound_email_id",
        "provider",
        "model",
        "status",
        "category",
        "labels_json",
        "priority",
        "confidence",
        "risk_score",
        "summary",
        "reasoning",
        "tool_calls_json",
        "output_json",
        "error",
        "started_at",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "email-agent-runs not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgentRuns",
    "path": "/v1/email-agent-runs/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEmailAgents",
    "path": "/v1/email-agents",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped email-agents row.",
            "properties": {
              "agent_key": {
                "type": "string"
              },
              "enabled": {
                "type": "boolean"
              },
              "always_on": {
                "type": "boolean"
              },
              "provider": {
                "type": "string",
                "nullable": true
              },
              "model": {
                "type": "string",
                "nullable": true
              },
              "apply_labels": {
                "type": "boolean"
              },
              "use_network_tools": {
                "type": "boolean"
              },
              "config_json": {},
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "agent_key",
              "tenant_id",
              "enabled",
              "always_on",
              "provider",
              "model",
              "apply_labels",
              "use_network_tools",
              "config_json",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEmailAgents",
    "path": "/v1/email-agents",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEmailAgents",
    "path": "/v1/email-agents",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEmailAgents",
    "path": "/v1/email-agents",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailAgents",
    "path": "/v1/email-agents",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped email-agents row.",
      "properties": {
        "agent_key": {
          "type": "string"
        },
        "enabled": {
          "type": "boolean"
        },
        "always_on": {
          "type": "boolean"
        },
        "provider": {
          "type": "string",
          "nullable": true
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "apply_labels": {
          "type": "boolean"
        },
        "use_network_tools": {
          "type": "boolean"
        },
        "config_json": {},
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "agent_key",
        "tenant_id",
        "enabled",
        "always_on",
        "provider",
        "model",
        "apply_labels",
        "use_network_tools",
        "config_json",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailAgents",
    "path": "/v1/email-agents",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailAgents",
    "path": "/v1/email-agents",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailAgents",
    "path": "/v1/email-agents",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailAgents",
    "path": "/v1/email-agents",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailAgents",
    "path": "/v1/email-agents",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "email-agents not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped email-agents row.",
      "properties": {
        "agent_key": {
          "type": "string"
        },
        "enabled": {
          "type": "boolean"
        },
        "always_on": {
          "type": "boolean"
        },
        "provider": {
          "type": "string",
          "nullable": true
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "apply_labels": {
          "type": "boolean"
        },
        "use_network_tools": {
          "type": "boolean"
        },
        "config_json": {},
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "agent_key",
        "tenant_id",
        "enabled",
        "always_on",
        "provider",
        "model",
        "apply_labels",
        "use_network_tools",
        "config_json",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "email-agents not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped email-agents row.",
      "properties": {
        "agent_key": {
          "type": "string"
        },
        "enabled": {
          "type": "boolean"
        },
        "always_on": {
          "type": "boolean"
        },
        "provider": {
          "type": "string",
          "nullable": true
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "apply_labels": {
          "type": "boolean"
        },
        "use_network_tools": {
          "type": "boolean"
        },
        "config_json": {},
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "agent_key",
        "tenant_id",
        "enabled",
        "always_on",
        "provider",
        "model",
        "apply_labels",
        "use_network_tools",
        "config_json",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "email-agents not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped email-agents row.",
      "properties": {
        "agent_key": {
          "type": "string"
        },
        "enabled": {
          "type": "boolean"
        },
        "always_on": {
          "type": "boolean"
        },
        "provider": {
          "type": "string",
          "nullable": true
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "apply_labels": {
          "type": "boolean"
        },
        "use_network_tools": {
          "type": "boolean"
        },
        "config_json": {},
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "agent_key",
        "tenant_id",
        "enabled",
        "always_on",
        "provider",
        "model",
        "apply_labels",
        "use_network_tools",
        "config_json",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "email-agents not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailAgents",
    "path": "/v1/email-agents/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEmailDigests",
    "path": "/v1/email-digests",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped email-digests row.",
            "properties": {
              "period": {
                "type": "string",
                "nullable": true
              },
              "since": {
                "type": "string",
                "nullable": true
              },
              "until": {
                "type": "string",
                "nullable": true
              },
              "provider": {
                "type": "string",
                "nullable": true
              },
              "model": {
                "type": "string",
                "nullable": true
              },
              "status": {
                "type": "string",
                "nullable": true
              },
              "message_count": {
                "type": "integer"
              },
              "summary": {
                "type": "string",
                "nullable": true
              },
              "highlights_json": {},
              "action_items_json": {},
              "important_email_ids_json": {},
              "label_counts_json": {},
              "error": {
                "type": "string",
                "nullable": true
              },
              "started_at": {
                "type": "string",
                "nullable": true
              },
              "completed_at": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "period",
              "since",
              "until",
              "provider",
              "model",
              "status",
              "message_count",
              "summary",
              "highlights_json",
              "action_items_json",
              "important_email_ids_json",
              "label_counts_json",
              "error",
              "started_at",
              "completed_at",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEmailDigests",
    "path": "/v1/email-digests",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEmailDigests",
    "path": "/v1/email-digests",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEmailDigests",
    "path": "/v1/email-digests",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailDigests",
    "path": "/v1/email-digests",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped email-digests row.",
      "properties": {
        "period": {
          "type": "string",
          "nullable": true
        },
        "since": {
          "type": "string",
          "nullable": true
        },
        "until": {
          "type": "string",
          "nullable": true
        },
        "provider": {
          "type": "string",
          "nullable": true
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "message_count": {
          "type": "integer"
        },
        "summary": {
          "type": "string",
          "nullable": true
        },
        "highlights_json": {},
        "action_items_json": {},
        "important_email_ids_json": {},
        "label_counts_json": {},
        "error": {
          "type": "string",
          "nullable": true
        },
        "started_at": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "period",
        "since",
        "until",
        "provider",
        "model",
        "status",
        "message_count",
        "summary",
        "highlights_json",
        "action_items_json",
        "important_email_ids_json",
        "label_counts_json",
        "error",
        "started_at",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailDigests",
    "path": "/v1/email-digests",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailDigests",
    "path": "/v1/email-digests",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailDigests",
    "path": "/v1/email-digests",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailDigests",
    "path": "/v1/email-digests",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEmailDigests",
    "path": "/v1/email-digests",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "email-digests not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped email-digests row.",
      "properties": {
        "period": {
          "type": "string",
          "nullable": true
        },
        "since": {
          "type": "string",
          "nullable": true
        },
        "until": {
          "type": "string",
          "nullable": true
        },
        "provider": {
          "type": "string",
          "nullable": true
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "message_count": {
          "type": "integer"
        },
        "summary": {
          "type": "string",
          "nullable": true
        },
        "highlights_json": {},
        "action_items_json": {},
        "important_email_ids_json": {},
        "label_counts_json": {},
        "error": {
          "type": "string",
          "nullable": true
        },
        "started_at": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "period",
        "since",
        "until",
        "provider",
        "model",
        "status",
        "message_count",
        "summary",
        "highlights_json",
        "action_items_json",
        "important_email_ids_json",
        "label_counts_json",
        "error",
        "started_at",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "email-digests not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped email-digests row.",
      "properties": {
        "period": {
          "type": "string",
          "nullable": true
        },
        "since": {
          "type": "string",
          "nullable": true
        },
        "until": {
          "type": "string",
          "nullable": true
        },
        "provider": {
          "type": "string",
          "nullable": true
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "message_count": {
          "type": "integer"
        },
        "summary": {
          "type": "string",
          "nullable": true
        },
        "highlights_json": {},
        "action_items_json": {},
        "important_email_ids_json": {},
        "label_counts_json": {},
        "error": {
          "type": "string",
          "nullable": true
        },
        "started_at": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "period",
        "since",
        "until",
        "provider",
        "model",
        "status",
        "message_count",
        "summary",
        "highlights_json",
        "action_items_json",
        "important_email_ids_json",
        "label_counts_json",
        "error",
        "started_at",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "email-digests not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped email-digests row.",
      "properties": {
        "period": {
          "type": "string",
          "nullable": true
        },
        "since": {
          "type": "string",
          "nullable": true
        },
        "until": {
          "type": "string",
          "nullable": true
        },
        "provider": {
          "type": "string",
          "nullable": true
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "message_count": {
          "type": "integer"
        },
        "summary": {
          "type": "string",
          "nullable": true
        },
        "highlights_json": {},
        "action_items_json": {},
        "important_email_ids_json": {},
        "label_counts_json": {},
        "error": {
          "type": "string",
          "nullable": true
        },
        "started_at": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "period",
        "since",
        "until",
        "provider",
        "model",
        "status",
        "message_count",
        "summary",
        "highlights_json",
        "action_items_json",
        "important_email_ids_json",
        "label_counts_json",
        "error",
        "started_at",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "email-digests not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEmailDigests",
    "path": "/v1/email-digests/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEvents",
    "path": "/v1/events",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped events row.",
            "properties": {
              "email_id": {
                "type": "string",
                "nullable": true
              },
              "provider_id": {
                "type": "string",
                "nullable": true
              },
              "provider_event_id": {
                "type": "string",
                "nullable": true
              },
              "type": {
                "type": "string",
                "nullable": true
              },
              "recipient": {
                "type": "string",
                "nullable": true
              },
              "metadata": {},
              "occurred_at": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "email_id",
              "provider_id",
              "provider_event_id",
              "type",
              "recipient",
              "metadata",
              "occurred_at",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEvents",
    "path": "/v1/events",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEvents",
    "path": "/v1/events",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceEvents",
    "path": "/v1/events",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEvents",
    "path": "/v1/events",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped events row.",
      "properties": {
        "email_id": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "provider_event_id": {
          "type": "string",
          "nullable": true
        },
        "type": {
          "type": "string",
          "nullable": true
        },
        "recipient": {
          "type": "string",
          "nullable": true
        },
        "metadata": {},
        "occurred_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "email_id",
        "provider_id",
        "provider_event_id",
        "type",
        "recipient",
        "metadata",
        "occurred_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEvents",
    "path": "/v1/events",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEvents",
    "path": "/v1/events",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEvents",
    "path": "/v1/events",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEvents",
    "path": "/v1/events",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "cross_tenant_reference"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEvents",
    "path": "/v1/events",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceEvents",
    "path": "/v1/events",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEvents",
    "path": "/v1/events/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEvents",
    "path": "/v1/events/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEvents",
    "path": "/v1/events/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEvents",
    "path": "/v1/events/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "events not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceEvents",
    "path": "/v1/events/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEvents",
    "path": "/v1/events/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped events row.",
      "properties": {
        "email_id": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "provider_event_id": {
          "type": "string",
          "nullable": true
        },
        "type": {
          "type": "string",
          "nullable": true
        },
        "recipient": {
          "type": "string",
          "nullable": true
        },
        "metadata": {},
        "occurred_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "email_id",
        "provider_id",
        "provider_event_id",
        "type",
        "recipient",
        "metadata",
        "occurred_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEvents",
    "path": "/v1/events/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEvents",
    "path": "/v1/events/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEvents",
    "path": "/v1/events/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "events not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceEvents",
    "path": "/v1/events/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEvents",
    "path": "/v1/events/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped events row.",
      "properties": {
        "email_id": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "provider_event_id": {
          "type": "string",
          "nullable": true
        },
        "type": {
          "type": "string",
          "nullable": true
        },
        "recipient": {
          "type": "string",
          "nullable": true
        },
        "metadata": {},
        "occurred_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "email_id",
        "provider_id",
        "provider_event_id",
        "type",
        "recipient",
        "metadata",
        "occurred_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEvents",
    "path": "/v1/events/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEvents",
    "path": "/v1/events/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEvents",
    "path": "/v1/events/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEvents",
    "path": "/v1/events/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "events not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEvents",
    "path": "/v1/events/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceEvents",
    "path": "/v1/events/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEvents",
    "path": "/v1/events/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped events row.",
      "properties": {
        "email_id": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "provider_event_id": {
          "type": "string",
          "nullable": true
        },
        "type": {
          "type": "string",
          "nullable": true
        },
        "recipient": {
          "type": "string",
          "nullable": true
        },
        "metadata": {},
        "occurred_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "email_id",
        "provider_id",
        "provider_event_id",
        "type",
        "recipient",
        "metadata",
        "occurred_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEvents",
    "path": "/v1/events/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEvents",
    "path": "/v1/events/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEvents",
    "path": "/v1/events/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEvents",
    "path": "/v1/events/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "events not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEvents",
    "path": "/v1/events/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceEvents",
    "path": "/v1/events/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceForwarding",
    "path": "/v1/forwarding",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped forwarding row.",
            "properties": {
              "source_address": {
                "type": "string",
                "nullable": true
              },
              "target_address": {
                "type": "string",
                "nullable": true
              },
              "mode": {
                "type": "string",
                "nullable": true
              },
              "provider_id": {
                "type": "string",
                "nullable": true
              },
              "from_address": {
                "type": "string",
                "nullable": true
              },
              "enabled": {
                "type": "boolean"
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "source_address",
              "target_address",
              "mode",
              "provider_id",
              "from_address",
              "enabled",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceForwarding",
    "path": "/v1/forwarding",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceForwarding",
    "path": "/v1/forwarding",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceForwarding",
    "path": "/v1/forwarding",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceForwarding",
    "path": "/v1/forwarding",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped forwarding row.",
      "properties": {
        "source_address": {
          "type": "string",
          "nullable": true
        },
        "target_address": {
          "type": "string",
          "nullable": true
        },
        "mode": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "enabled": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "source_address",
        "target_address",
        "mode",
        "provider_id",
        "from_address",
        "enabled",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceForwarding",
    "path": "/v1/forwarding",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceForwarding",
    "path": "/v1/forwarding",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceForwarding",
    "path": "/v1/forwarding",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceForwarding",
    "path": "/v1/forwarding",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "cross_tenant_reference"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceForwarding",
    "path": "/v1/forwarding",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceForwarding",
    "path": "/v1/forwarding",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "forwarding not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped forwarding row.",
      "properties": {
        "source_address": {
          "type": "string",
          "nullable": true
        },
        "target_address": {
          "type": "string",
          "nullable": true
        },
        "mode": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "enabled": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "source_address",
        "target_address",
        "mode",
        "provider_id",
        "from_address",
        "enabled",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "forwarding not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped forwarding row.",
      "properties": {
        "source_address": {
          "type": "string",
          "nullable": true
        },
        "target_address": {
          "type": "string",
          "nullable": true
        },
        "mode": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "enabled": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "source_address",
        "target_address",
        "mode",
        "provider_id",
        "from_address",
        "enabled",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "forwarding not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped forwarding row.",
      "properties": {
        "source_address": {
          "type": "string",
          "nullable": true
        },
        "target_address": {
          "type": "string",
          "nullable": true
        },
        "mode": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "enabled": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "source_address",
        "target_address",
        "mode",
        "provider_id",
        "from_address",
        "enabled",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "forwarding not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceForwarding",
    "path": "/v1/forwarding/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceGroupMembers",
    "path": "/v1/group-members",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped group-members row.",
            "properties": {
              "group_id": {
                "type": "string",
                "nullable": true
              },
              "email": {
                "type": "string",
                "nullable": true
              },
              "name": {
                "type": "string",
                "nullable": true
              },
              "vars": {
                "type": "string",
                "nullable": true
              },
              "added_at": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "group_id",
              "email",
              "name",
              "vars",
              "added_at",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceGroupMembers",
    "path": "/v1/group-members",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceGroupMembers",
    "path": "/v1/group-members",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceGroupMembers",
    "path": "/v1/group-members",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroupMembers",
    "path": "/v1/group-members",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped group-members row.",
      "properties": {
        "group_id": {
          "type": "string",
          "nullable": true
        },
        "email": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "vars": {
          "type": "string",
          "nullable": true
        },
        "added_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "group_id",
        "email",
        "name",
        "vars",
        "added_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroupMembers",
    "path": "/v1/group-members",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroupMembers",
    "path": "/v1/group-members",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroupMembers",
    "path": "/v1/group-members",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroupMembers",
    "path": "/v1/group-members",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "cross_tenant_reference"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroupMembers",
    "path": "/v1/group-members",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroupMembers",
    "path": "/v1/group-members",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "group-members not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped group-members row.",
      "properties": {
        "group_id": {
          "type": "string",
          "nullable": true
        },
        "email": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "vars": {
          "type": "string",
          "nullable": true
        },
        "added_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "group_id",
        "email",
        "name",
        "vars",
        "added_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "group-members not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped group-members row.",
      "properties": {
        "group_id": {
          "type": "string",
          "nullable": true
        },
        "email": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "vars": {
          "type": "string",
          "nullable": true
        },
        "added_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "group_id",
        "email",
        "name",
        "vars",
        "added_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "group-members not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped group-members row.",
      "properties": {
        "group_id": {
          "type": "string",
          "nullable": true
        },
        "email": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "vars": {
          "type": "string",
          "nullable": true
        },
        "added_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "group_id",
        "email",
        "name",
        "vars",
        "added_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "group-members not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroupMembers",
    "path": "/v1/group-members/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceGroups",
    "path": "/v1/groups",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped groups row.",
            "properties": {
              "name": {
                "type": "string",
                "nullable": true
              },
              "description": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "name",
              "description",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceGroups",
    "path": "/v1/groups",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceGroups",
    "path": "/v1/groups",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceGroups",
    "path": "/v1/groups",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroups",
    "path": "/v1/groups",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped groups row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "description": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "description",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroups",
    "path": "/v1/groups",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroups",
    "path": "/v1/groups",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroups",
    "path": "/v1/groups",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroups",
    "path": "/v1/groups",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceGroups",
    "path": "/v1/groups",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "groups not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped groups row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "description": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "description",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "groups not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped groups row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "description": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "description",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "groups not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped groups row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "description": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "description",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "groups not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceGroups",
    "path": "/v1/groups/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "acceptInvite",
    "path": "/v1/invites/accept",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "session_token": {
          "type": "string"
        },
        "expires_at": {
          "type": "string",
          "format": "date-time"
        },
        "user": {
          "$ref": "#/components/schemas/User"
        },
        "tenant": {
          "$ref": "#/components/schemas/Tenant",
          "nullable": true
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "admin",
            "member",
            "viewer"
          ]
        }
      },
      "required": [
        "session_token",
        "expires_at",
        "user",
        "tenant",
        "role"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "acceptInvite",
    "path": "/v1/invites/accept",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "acceptInvite",
    "path": "/v1/invites/accept",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "acceptInvite",
    "path": "/v1/invites/accept",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "acceptInvite",
    "path": "/v1/invites/accept",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenantKeys",
    "path": "/v1/keys",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "keys": {
          "type": "array",
          "items": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ApiKeyMetadata"
              },
              {
                "type": "object",
                "additionalProperties": true,
                "properties": {
                  "kid": {
                    "type": "string"
                  },
                  "app": {
                    "type": "string"
                  },
                  "agent": {
                    "type": "string",
                    "nullable": true
                  },
                  "scopes": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "issued_at": {
                    "type": "string",
                    "format": "date-time"
                  },
                  "expires_at": {
                    "type": "string",
                    "format": "date-time",
                    "nullable": true
                  },
                  "revoked_at": {
                    "type": "string",
                    "format": "date-time",
                    "nullable": true
                  },
                  "last_used_at": {
                    "type": "string",
                    "format": "date-time",
                    "nullable": true
                  },
                  "created_by_user_id": {
                    "type": "string",
                    "format": "uuid",
                    "nullable": true
                  },
                  "created_at": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "kid",
                  "scopes",
                  "created_at",
                  "expires_at",
                  "revoked_at"
                ]
              }
            ]
          }
        }
      },
      "required": [
        "keys"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenantKeys",
    "path": "/v1/keys",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenantKeys",
    "path": "/v1/keys",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenantKeys",
    "path": "/v1/keys",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantKey",
    "path": "/v1/keys",
    "status": 201,
    "schema": {
      "type": "object",
      "properties": {
        "token": {
          "type": "string"
        },
        "kid": {
          "type": "string"
        },
        "scopes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "expires_at": {
          "type": "string",
          "format": "date-time",
          "nullable": true
        }
      },
      "required": [
        "token",
        "kid",
        "scopes",
        "expires_at"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantKey",
    "path": "/v1/keys",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantKey",
    "path": "/v1/keys",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantKey",
    "path": "/v1/keys",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantKey",
    "path": "/v1/keys",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantKey",
    "path": "/v1/keys",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "revokeTenantKey",
    "path": "/v1/keys/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "revoked": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "kid": {
          "type": "string"
        }
      },
      "required": [
        "revoked",
        "kid"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "revokeTenantKey",
    "path": "/v1/keys/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "revokeTenantKey",
    "path": "/v1/keys/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "revokeTenantKey",
    "path": "/v1/keys/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "key not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "key not found"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "not_found"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "revokeTenantKey",
    "path": "/v1/keys/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "revokeTenantKeyByPost",
    "path": "/v1/keys/{id}/revoke",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "revoked": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "kid": {
          "type": "string"
        }
      },
      "required": [
        "revoked",
        "kid"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "revokeTenantKeyByPost",
    "path": "/v1/keys/{id}/revoke",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "revokeTenantKeyByPost",
    "path": "/v1/keys/{id}/revoke",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "revokeTenantKeyByPost",
    "path": "/v1/keys/{id}/revoke",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "key not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "key not found"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "not_found"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "revokeTenantKeyByPost",
    "path": "/v1/keys/{id}/revoke",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listMailboxes",
    "path": "/v1/mailboxes",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "mailboxes": {
          "type": "array",
          "items": {
            "$ref": "#/components/schemas/Mailbox"
          }
        },
        "counts": {
          "$ref": "#/components/schemas/MessageCounts"
        }
      },
      "required": [
        "mailboxes",
        "counts"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listMailboxes",
    "path": "/v1/mailboxes",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listMailboxes",
    "path": "/v1/mailboxes",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listMailboxes",
    "path": "/v1/mailboxes",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getCurrentPrincipal",
    "path": "/v1/me",
    "status": 200,
    "schema": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "principal_type": {
              "type": "string",
              "enum": [
                "apikey"
              ]
            },
            "kid": {
              "type": "string"
            },
            "tenant": {
              "oneOf": [
                {
                  "type": "object",
                  "additionalProperties": true,
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1
                    },
                    "slug": {
                      "type": "string"
                    },
                    "name": {
                      "type": "string"
                    },
                    "status": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "id",
                    "slug",
                    "name",
                    "status"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "id"
                  ]
                }
              ]
            },
            "scopes": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "principal_type",
            "kid",
            "tenant",
            "scopes"
          ]
        },
        {
          "type": "object",
          "properties": {
            "principal_type": {
              "type": "string",
              "enum": [
                "user"
              ]
            },
            "user": {
              "type": "object",
              "additionalProperties": true,
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1
                },
                "email": {
                  "type": "string",
                  "format": "email"
                },
                "name": {
                  "type": "string",
                  "nullable": true
                },
                "status": {
                  "type": "string"
                },
                "email_verified": {
                  "type": "boolean"
                },
                "global_role": {
                  "type": "string",
                  "enum": [
                    "user",
                    "super_admin"
                  ]
                },
                "is_primary_super_admin": {
                  "type": "boolean"
                },
                "created_at": {
                  "type": "string",
                  "format": "date-time"
                }
              },
              "required": [
                "id",
                "email",
                "name",
                "status",
                "email_verified",
                "created_at"
              ],
              "nullable": true
            },
            "tenant": {
              "oneOf": [
                {
                  "type": "object",
                  "additionalProperties": true,
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1
                    },
                    "slug": {
                      "type": "string"
                    },
                    "name": {
                      "type": "string"
                    },
                    "status": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "id",
                    "slug",
                    "name",
                    "status"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "id"
                  ]
                }
              ]
            },
            "role": {
              "type": "string",
              "enum": [
                "owner",
                "admin",
                "member",
                "viewer"
              ]
            },
            "scopes": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "memberships": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "tenant_id": {
                    "type": "string",
                    "minLength": 1
                  },
                  "slug": {
                    "type": "string"
                  },
                  "name": {
                    "type": "string"
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "owner",
                      "admin",
                      "member",
                      "viewer"
                    ]
                  }
                },
                "required": [
                  "tenant_id",
                  "slug",
                  "name",
                  "role"
                ]
              }
            },
            "email_identities": {
              "type": "array",
              "items": {
                "$ref": "#/components/schemas/EmailIdentity"
              }
            }
          },
          "required": [
            "principal_type",
            "user",
            "tenant",
            "role",
            "scopes",
            "memberships",
            "email_identities"
          ]
        }
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getCurrentPrincipal",
    "path": "/v1/me",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getCurrentPrincipal",
    "path": "/v1/me",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getCurrentPrincipal",
    "path": "/v1/me",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listEmailIdentities",
    "path": "/v1/me/email-identities",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "email_identities": {
          "type": "array",
          "items": {
            "$ref": "#/components/schemas/EmailIdentity"
          }
        }
      },
      "required": [
        "email_identities"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listEmailIdentities",
    "path": "/v1/me/email-identities",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listEmailIdentities",
    "path": "/v1/me/email-identities",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listEmailIdentities",
    "path": "/v1/me/email-identities",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "addEmailIdentity",
    "path": "/v1/me/email-identities",
    "status": 201,
    "schema": {
      "type": "object",
      "properties": {
        "email_identity": {
          "$ref": "#/components/schemas/EmailIdentity"
        },
        "verification_required": {
          "type": "boolean",
          "enum": [
            true
          ]
        }
      },
      "required": [
        "email_identity",
        "verification_required"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "addEmailIdentity",
    "path": "/v1/me/email-identities",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "addEmailIdentity",
    "path": "/v1/me/email-identities",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "addEmailIdentity",
    "path": "/v1/me/email-identities",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "addEmailIdentity",
    "path": "/v1/me/email-identities",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "addEmailIdentity",
    "path": "/v1/me/email-identities",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "addEmailIdentity",
    "path": "/v1/me/email-identities",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "removeEmailIdentity",
    "path": "/v1/me/email-identities/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "removed": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "removed",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "removeEmailIdentity",
    "path": "/v1/me/email-identities/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "removeEmailIdentity",
    "path": "/v1/me/email-identities/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "removeEmailIdentity",
    "path": "/v1/me/email-identities/{id}",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "removeEmailIdentity",
    "path": "/v1/me/email-identities/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "makePrimaryEmailIdentity",
    "path": "/v1/me/email-identities/{id}/primary",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "email_identity": {
          "$ref": "#/components/schemas/EmailIdentity"
        }
      },
      "required": [
        "email_identity"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "makePrimaryEmailIdentity",
    "path": "/v1/me/email-identities/{id}/primary",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "makePrimaryEmailIdentity",
    "path": "/v1/me/email-identities/{id}/primary",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "makePrimaryEmailIdentity",
    "path": "/v1/me/email-identities/{id}/primary",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "makePrimaryEmailIdentity",
    "path": "/v1/me/email-identities/{id}/primary",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "removeMembership",
    "path": "/v1/memberships/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "removed": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "removed",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "removeMembership",
    "path": "/v1/memberships/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "removeMembership",
    "path": "/v1/memberships/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "removeMembership",
    "path": "/v1/memberships/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "membership not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "membership not found"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "not_found"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "removeMembership",
    "path": "/v1/memberships/{id}",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "removeMembership",
    "path": "/v1/memberships/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMembership",
    "path": "/v1/memberships/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "membership": {
          "$ref": "#/components/schemas/MembershipSummary"
        }
      },
      "required": [
        "membership"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMembership",
    "path": "/v1/memberships/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMembership",
    "path": "/v1/memberships/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMembership",
    "path": "/v1/memberships/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMembership",
    "path": "/v1/memberships/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "membership not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "membership not found"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "not_found"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMembership",
    "path": "/v1/memberships/{id}",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMembership",
    "path": "/v1/memberships/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMembership",
    "path": "/v1/memberships/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMembership",
    "path": "/v1/memberships/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "membership": {
          "$ref": "#/components/schemas/MembershipSummary"
        }
      },
      "required": [
        "membership"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMembership",
    "path": "/v1/memberships/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMembership",
    "path": "/v1/memberships/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMembership",
    "path": "/v1/memberships/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMembership",
    "path": "/v1/memberships/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "membership not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "membership not found"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "not_found"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMembership",
    "path": "/v1/memberships/{id}",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMembership",
    "path": "/v1/memberships/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMembership",
    "path": "/v1/memberships/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listMessages",
    "path": "/v1/messages",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "messages": {
          "type": "array",
          "items": {
            "$ref": "#/components/schemas/MessageListItem"
          }
        },
        "next_cursor": {
          "type": "string",
          "nullable": true,
          "description": "Cursor for the next page; null when this page is the last."
        }
      },
      "required": [
        "messages",
        "next_cursor"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listMessages",
    "path": "/v1/messages",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listMessages",
    "path": "/v1/messages",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listMessages",
    "path": "/v1/messages",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listMessages",
    "path": "/v1/messages",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createMessage",
    "path": "/v1/messages",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "message": {
          "$ref": "#/components/schemas/Message"
        }
      },
      "required": [
        "message"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createMessage",
    "path": "/v1/messages",
    "status": 201,
    "schema": {
      "type": "object",
      "properties": {
        "message": {
          "$ref": "#/components/schemas/Message"
        }
      },
      "required": [
        "message"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createMessage",
    "path": "/v1/messages",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createMessage",
    "path": "/v1/messages",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createMessage",
    "path": "/v1/messages",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createMessage",
    "path": "/v1/messages",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "outbound messages must be sent through POST /v1/messages/send"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createMessage",
    "path": "/v1/messages",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createMessage",
    "path": "/v1/messages",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteMessage",
    "path": "/v1/messages/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteMessage",
    "path": "/v1/messages/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteMessage",
    "path": "/v1/messages/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteMessage",
    "path": "/v1/messages/{id}",
    "status": 404,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteMessage",
    "path": "/v1/messages/{id}",
    "status": 409,
    "schema": {
      "$ref": "#/components/schemas/SendMessageError"
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteMessage",
    "path": "/v1/messages/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessage",
    "path": "/v1/messages/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "message": {
          "$ref": "#/components/schemas/Message"
        }
      },
      "required": [
        "message"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessage",
    "path": "/v1/messages/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessage",
    "path": "/v1/messages/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessage",
    "path": "/v1/messages/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "message not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessage",
    "path": "/v1/messages/{id}",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "ambiguous message id prefix"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "ambiguous_id"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessage",
    "path": "/v1/messages/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMessage",
    "path": "/v1/messages/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "message": {
          "$ref": "#/components/schemas/Message"
        }
      },
      "required": [
        "message"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMessage",
    "path": "/v1/messages/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMessage",
    "path": "/v1/messages/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMessage",
    "path": "/v1/messages/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMessage",
    "path": "/v1/messages/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "message not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMessage",
    "path": "/v1/messages/{id}",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "ambiguous message id prefix"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "ambiguous_id"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMessage",
    "path": "/v1/messages/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateMessage",
    "path": "/v1/messages/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMessage",
    "path": "/v1/messages/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "message": {
          "$ref": "#/components/schemas/Message"
        }
      },
      "required": [
        "message"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMessage",
    "path": "/v1/messages/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMessage",
    "path": "/v1/messages/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMessage",
    "path": "/v1/messages/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMessage",
    "path": "/v1/messages/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "message not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMessage",
    "path": "/v1/messages/{id}",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "ambiguous message id prefix"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "ambiguous_id"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMessage",
    "path": "/v1/messages/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceMessage",
    "path": "/v1/messages/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageAttachment",
    "path": "/v1/messages/{id}/attachments/{index}",
    "status": 200,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "attachment": {
          "$ref": "#/components/schemas/AttachmentContent"
        }
      },
      "required": [
        "attachment"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageAttachment",
    "path": "/v1/messages/{id}/attachments/{index}",
    "status": 400,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageAttachment",
    "path": "/v1/messages/{id}/attachments/{index}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageAttachment",
    "path": "/v1/messages/{id}/attachments/{index}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageAttachment",
    "path": "/v1/messages/{id}/attachments/{index}",
    "status": 404,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageAttachment",
    "path": "/v1/messages/{id}/attachments/{index}",
    "status": 409,
    "schema": {
      "$ref": "#/components/schemas/AttachmentUnavailableError"
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageAttachment",
    "path": "/v1/messages/{id}/attachments/{index}",
    "status": 413,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageAttachment",
    "path": "/v1/messages/{id}/attachments/{index}",
    "status": 422,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageAttachment",
    "path": "/v1/messages/{id}/attachments/{index}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageRaw",
    "path": "/v1/messages/{id}/raw",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "raw": {
          "type": "string"
        },
        "message_id": {
          "type": "string",
          "nullable": true
        }
      },
      "required": [
        "raw",
        "message_id"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageRaw",
    "path": "/v1/messages/{id}/raw",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageRaw",
    "path": "/v1/messages/{id}/raw",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageRaw",
    "path": "/v1/messages/{id}/raw",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "message not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageRaw",
    "path": "/v1/messages/{id}/raw",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "ambiguous message id prefix"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "ambiguous_id"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageRaw",
    "path": "/v1/messages/{id}/raw",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageCounts",
    "path": "/v1/messages/counts",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "counts": {
          "$ref": "#/components/schemas/MessageCounts"
        }
      },
      "required": [
        "counts"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageCounts",
    "path": "/v1/messages/counts",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageCounts",
    "path": "/v1/messages/counts",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageCounts",
    "path": "/v1/messages/counts",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageGroups",
    "path": "/v1/messages/groups",
    "status": 200,
    "schema": {
      "$ref": "#/components/schemas/MessageCounts"
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageGroups",
    "path": "/v1/messages/groups",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageGroups",
    "path": "/v1/messages/groups",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getMessageGroups",
    "path": "/v1/messages/groups",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "recordMessage",
    "path": "/v1/messages/record",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "message": {
          "$ref": "#/components/schemas/Message"
        }
      },
      "required": [
        "message"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "recordMessage",
    "path": "/v1/messages/record",
    "status": 201,
    "schema": {
      "type": "object",
      "properties": {
        "message": {
          "$ref": "#/components/schemas/Message"
        }
      },
      "required": [
        "message"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "recordMessage",
    "path": "/v1/messages/record",
    "status": 400,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "error",
            "reason"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "error"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "recordMessage",
    "path": "/v1/messages/record",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "recordMessage",
    "path": "/v1/messages/record",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "recordMessage",
    "path": "/v1/messages/record",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "recordMessage",
    "path": "/v1/messages/record",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "sendMessage",
    "path": "/v1/messages/send",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "message": {
          "$ref": "#/components/schemas/Message"
        },
        "provider": {
          "type": "string"
        },
        "idempotent_replay": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "sent": {
          "type": "boolean",
          "enum": [
            true
          ],
          "description": "Present whenever the provider accepted the message (fresh success, idempotent replay of a sent intent, or a post-send finalization failure): the message WAS sent"
        },
        "provider_message_id": {
          "type": "string",
          "minLength": 1,
          "description": "Provider message id, present whenever the provider accepted the message — including when ledger finalization failed, so the accepted send stays traceable"
        }
      },
      "required": [
        "message",
        "provider",
        "idempotent_replay",
        "sent",
        "provider_message_id"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "sendMessage",
    "path": "/v1/messages/send",
    "status": 202,
    "schema": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "message": {
              "$ref": "#/components/schemas/Message"
            },
            "provider": {
              "type": "string"
            },
            "in_progress": {
              "type": "boolean",
              "enum": [
                true
              ]
            }
          },
          "required": [
            "message",
            "provider",
            "in_progress"
          ]
        },
        {
          "type": "object",
          "properties": {
            "message": {
              "$ref": "#/components/schemas/Message"
            },
            "provider": {
              "type": "string"
            },
            "sent": {
              "type": "boolean",
              "enum": [
                true
              ]
            },
            "provider_message_id": {
              "type": "string",
              "minLength": 1
            },
            "warning": {
              "type": "string",
              "description": "Present only when the provider accepted the message but ledger finalization failed; the send must not be retried."
            },
            "retry_safe": {
              "type": "boolean",
              "enum": [
                false
              ],
              "description": "Present with warning and always false."
            }
          },
          "required": [
            "message",
            "provider",
            "sent",
            "provider_message_id"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "sendMessage",
    "path": "/v1/messages/send",
    "status": 400,
    "schema": {
      "anyOf": [
        {
          "$ref": "#/components/schemas/ErrorResponse"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "error"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "sendMessage",
    "path": "/v1/messages/send",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "sendMessage",
    "path": "/v1/messages/send",
    "status": 403,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "error",
            "reason"
          ]
        },
        {
          "$ref": "#/components/schemas/SendMessageError"
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "sendMessage",
    "path": "/v1/messages/send",
    "status": 409,
    "schema": {
      "$ref": "#/components/schemas/SendMessageError"
    }
  },
  {
    "method": "POST",
    "operationId": "sendMessage",
    "path": "/v1/messages/send",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "sendMessage",
    "path": "/v1/messages/send",
    "status": 422,
    "schema": {
      "$ref": "#/components/schemas/SendMessageError"
    }
  },
  {
    "method": "POST",
    "operationId": "sendMessage",
    "path": "/v1/messages/send",
    "status": 429,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "POST",
    "operationId": "sendMessage",
    "path": "/v1/messages/send",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "sendMessage",
    "path": "/v1/messages/send",
    "status": 502,
    "schema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "provider_outcome_uncertain"
          ]
        },
        "provider_error": {
          "type": "string"
        },
        "sent": {
          "type": "boolean",
          "nullable": true,
          "enum": [
            null
          ]
        },
        "retry_safe": {
          "type": "boolean",
          "enum": [
            false
          ]
        },
        "reconciliation_required": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "message": {
          "$ref": "#/components/schemas/Message"
        }
      },
      "required": [
        "error",
        "reason",
        "sent",
        "retry_safe",
        "reconciliation_required",
        "message"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "sendMessage",
    "path": "/v1/messages/send",
    "status": 503,
    "schema": {
      "$ref": "#/components/schemas/SendMessageError"
    }
  },
  {
    "method": "POST",
    "operationId": "cancelSendIntent",
    "path": "/v1/messages/send-intents/cancel",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "cancellation": {
          "$ref": "#/components/schemas/SendIntentCancellation"
        }
      },
      "required": [
        "cancellation"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "cancelSendIntent",
    "path": "/v1/messages/send-intents/cancel",
    "status": 400,
    "schema": {
      "anyOf": [
        {
          "$ref": "#/components/schemas/ErrorResponse"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "error"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "cancelSendIntent",
    "path": "/v1/messages/send-intents/cancel",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "cancelSendIntent",
    "path": "/v1/messages/send-intents/cancel",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "cancelSendIntent",
    "path": "/v1/messages/send-intents/cancel",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "cancelSendIntent",
    "path": "/v1/messages/send-intents/cancel",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "lookupSendIntent",
    "path": "/v1/messages/send-intents/lookup",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "send_intent": {
          "$ref": "#/components/schemas/SendIntentLookup"
        }
      },
      "required": [
        "send_intent"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "lookupSendIntent",
    "path": "/v1/messages/send-intents/lookup",
    "status": 400,
    "schema": {
      "anyOf": [
        {
          "$ref": "#/components/schemas/ErrorResponse"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "error"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "lookupSendIntent",
    "path": "/v1/messages/send-intents/lookup",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "lookupSendIntent",
    "path": "/v1/messages/send-intents/lookup",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "lookupSendIntent",
    "path": "/v1/messages/send-intents/lookup",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "lookupSendIntent",
    "path": "/v1/messages/send-intents/lookup",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "reconcileSendIntent",
    "path": "/v1/messages/send-intents/reconcile",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "reconciled": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "outcome": {
          "type": "string",
          "enum": [
            "sent",
            "not_sent"
          ]
        },
        "message": {
          "$ref": "#/components/schemas/Message"
        }
      },
      "required": [
        "reconciled",
        "outcome",
        "message"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "reconcileSendIntent",
    "path": "/v1/messages/send-intents/reconcile",
    "status": 400,
    "schema": {
      "anyOf": [
        {
          "$ref": "#/components/schemas/ErrorResponse"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "error"
          ]
        }
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "reconcileSendIntent",
    "path": "/v1/messages/send-intents/reconcile",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "reconcileSendIntent",
    "path": "/v1/messages/send-intents/reconcile",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "reconcileSendIntent",
    "path": "/v1/messages/send-intents/reconcile",
    "status": 404,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "POST",
    "operationId": "reconcileSendIntent",
    "path": "/v1/messages/send-intents/reconcile",
    "status": 409,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "POST",
    "operationId": "reconcileSendIntent",
    "path": "/v1/messages/send-intents/reconcile",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "reconcileSendIntent",
    "path": "/v1/messages/send-intents/reconcile",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listUncertainSendIntents",
    "path": "/v1/messages/send-intents/uncertain",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "uncertain": {
          "type": "array",
          "items": {
            "$ref": "#/components/schemas/Message"
          }
        },
        "count": {
          "type": "integer"
        }
      },
      "required": [
        "uncertain",
        "count"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listUncertainSendIntents",
    "path": "/v1/messages/send-intents/uncertain",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listUncertainSendIntents",
    "path": "/v1/messages/send-intents/uncertain",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listUncertainSendIntents",
    "path": "/v1/messages/send-intents/uncertain",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listThreads",
    "path": "/v1/messages/threads",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "threads": {
          "type": "array",
          "items": {
            "$ref": "#/components/schemas/Thread"
          }
        }
      },
      "required": [
        "threads"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listThreads",
    "path": "/v1/messages/threads",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listThreads",
    "path": "/v1/messages/threads",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listThreads",
    "path": "/v1/messages/threads",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getVersionedOpenApiDocument",
    "path": "/v1/openapi.json",
    "status": 200,
    "schema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "openapi": {
          "type": "string"
        },
        "info": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "title": {
              "type": "string"
            },
            "version": {
              "type": "string"
            }
          },
          "required": [
            "title",
            "version"
          ]
        },
        "security": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "paths": {
          "type": "object",
          "additionalProperties": true
        },
        "components": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "required": [
        "openapi",
        "info",
        "security",
        "paths",
        "components"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceOwners",
    "path": "/v1/owners",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped owners row.",
            "properties": {
              "type": {
                "type": "string",
                "nullable": true
              },
              "name": {
                "type": "string",
                "nullable": true
              },
              "contact_email": {
                "type": "string",
                "nullable": true
              },
              "external_id": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "type",
              "name",
              "contact_email",
              "external_id",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceOwners",
    "path": "/v1/owners",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceOwners",
    "path": "/v1/owners",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceOwners",
    "path": "/v1/owners",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceOwners",
    "path": "/v1/owners",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped owners row.",
      "properties": {
        "type": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "contact_email": {
          "type": "string",
          "nullable": true
        },
        "external_id": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "type",
        "name",
        "contact_email",
        "external_id",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceOwners",
    "path": "/v1/owners",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceOwners",
    "path": "/v1/owners",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceOwners",
    "path": "/v1/owners",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceOwners",
    "path": "/v1/owners",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceOwners",
    "path": "/v1/owners",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "owners not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped owners row.",
      "properties": {
        "type": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "contact_email": {
          "type": "string",
          "nullable": true
        },
        "external_id": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "type",
        "name",
        "contact_email",
        "external_id",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "owners not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped owners row.",
      "properties": {
        "type": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "contact_email": {
          "type": "string",
          "nullable": true
        },
        "external_id": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "type",
        "name",
        "contact_email",
        "external_id",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "owners not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped owners row.",
      "properties": {
        "type": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "contact_email": {
          "type": "string",
          "nullable": true
        },
        "external_id": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "type",
        "name",
        "contact_email",
        "external_id",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "owners not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceOwners",
    "path": "/v1/owners/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceProviders",
    "path": "/v1/providers",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped providers row.",
            "properties": {
              "name": {
                "type": "string",
                "nullable": true
              },
              "type": {
                "type": "string",
                "nullable": true
              },
              "region": {
                "type": "string",
                "nullable": true
              },
              "active": {
                "type": "boolean"
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "name",
              "type",
              "region",
              "active",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceProviders",
    "path": "/v1/providers",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceProviders",
    "path": "/v1/providers",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceProviders",
    "path": "/v1/providers",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceProviders",
    "path": "/v1/providers",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped providers row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "type": {
          "type": "string",
          "nullable": true
        },
        "region": {
          "type": "string",
          "nullable": true
        },
        "active": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "type",
        "region",
        "active",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceProviders",
    "path": "/v1/providers",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceProviders",
    "path": "/v1/providers",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceProviders",
    "path": "/v1/providers",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceProviders",
    "path": "/v1/providers",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceProviders",
    "path": "/v1/providers",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "providers not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped providers row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "type": {
          "type": "string",
          "nullable": true
        },
        "region": {
          "type": "string",
          "nullable": true
        },
        "active": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "type",
        "region",
        "active",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "providers not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped providers row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "type": {
          "type": "string",
          "nullable": true
        },
        "region": {
          "type": "string",
          "nullable": true
        },
        "active": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "type",
        "region",
        "active",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "providers not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped providers row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "type": {
          "type": "string",
          "nullable": true
        },
        "region": {
          "type": "string",
          "nullable": true
        },
        "active": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "type",
        "region",
        "active",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "providers not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProviders",
    "path": "/v1/providers/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceProvisioning",
    "path": "/v1/provisioning",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped provisioning row.",
            "properties": {
              "entity_type": {
                "type": "string",
                "nullable": true
              },
              "entity_id": {
                "type": "string",
                "nullable": true
              },
              "from_state": {
                "type": "string",
                "nullable": true
              },
              "to_state": {
                "type": "string",
                "nullable": true
              },
              "detail_json": {},
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "entity_type",
              "entity_id",
              "from_state",
              "to_state",
              "detail_json",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceProvisioning",
    "path": "/v1/provisioning",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceProvisioning",
    "path": "/v1/provisioning",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceProvisioning",
    "path": "/v1/provisioning",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceProvisioning",
    "path": "/v1/provisioning",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped provisioning row.",
      "properties": {
        "entity_type": {
          "type": "string",
          "nullable": true
        },
        "entity_id": {
          "type": "string",
          "nullable": true
        },
        "from_state": {
          "type": "string",
          "nullable": true
        },
        "to_state": {
          "type": "string",
          "nullable": true
        },
        "detail_json": {},
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "entity_type",
        "entity_id",
        "from_state",
        "to_state",
        "detail_json",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceProvisioning",
    "path": "/v1/provisioning",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceProvisioning",
    "path": "/v1/provisioning",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceProvisioning",
    "path": "/v1/provisioning",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceProvisioning",
    "path": "/v1/provisioning",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceProvisioning",
    "path": "/v1/provisioning",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "provisioning not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped provisioning row.",
      "properties": {
        "entity_type": {
          "type": "string",
          "nullable": true
        },
        "entity_id": {
          "type": "string",
          "nullable": true
        },
        "from_state": {
          "type": "string",
          "nullable": true
        },
        "to_state": {
          "type": "string",
          "nullable": true
        },
        "detail_json": {},
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "entity_type",
        "entity_id",
        "from_state",
        "to_state",
        "detail_json",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "provisioning not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped provisioning row.",
      "properties": {
        "entity_type": {
          "type": "string",
          "nullable": true
        },
        "entity_id": {
          "type": "string",
          "nullable": true
        },
        "from_state": {
          "type": "string",
          "nullable": true
        },
        "to_state": {
          "type": "string",
          "nullable": true
        },
        "detail_json": {},
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "entity_type",
        "entity_id",
        "from_state",
        "to_state",
        "detail_json",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "provisioning not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped provisioning row.",
      "properties": {
        "entity_type": {
          "type": "string",
          "nullable": true
        },
        "entity_id": {
          "type": "string",
          "nullable": true
        },
        "from_state": {
          "type": "string",
          "nullable": true
        },
        "to_state": {
          "type": "string",
          "nullable": true
        },
        "detail_json": {},
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "entity_type",
        "entity_id",
        "from_state",
        "to_state",
        "detail_json",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "provisioning not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceProvisioning",
    "path": "/v1/provisioning/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSandboxEmails",
    "path": "/v1/sandbox-emails",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped sandbox-emails row.",
            "properties": {
              "provider_id": {
                "type": "string",
                "nullable": true
              },
              "from_address": {
                "type": "string",
                "nullable": true
              },
              "to_addresses": {},
              "cc_addresses": {},
              "bcc_addresses": {},
              "reply_to": {
                "type": "string",
                "nullable": true
              },
              "subject": {
                "type": "string",
                "nullable": true
              },
              "html": {
                "type": "string",
                "nullable": true
              },
              "text_body": {
                "type": "string",
                "nullable": true
              },
              "attachments_json": {
                "type": "string",
                "nullable": true
              },
              "headers_json": {
                "type": "string",
                "nullable": true
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "provider_id",
              "from_address",
              "to_addresses",
              "cc_addresses",
              "bcc_addresses",
              "reply_to",
              "subject",
              "html",
              "text_body",
              "attachments_json",
              "headers_json",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSandboxEmails",
    "path": "/v1/sandbox-emails",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSandboxEmails",
    "path": "/v1/sandbox-emails",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSandboxEmails",
    "path": "/v1/sandbox-emails",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSandboxEmails",
    "path": "/v1/sandbox-emails",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sandbox-emails row.",
      "properties": {
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "to_addresses": {},
        "cc_addresses": {},
        "bcc_addresses": {},
        "reply_to": {
          "type": "string",
          "nullable": true
        },
        "subject": {
          "type": "string",
          "nullable": true
        },
        "html": {
          "type": "string",
          "nullable": true
        },
        "text_body": {
          "type": "string",
          "nullable": true
        },
        "attachments_json": {
          "type": "string",
          "nullable": true
        },
        "headers_json": {
          "type": "string",
          "nullable": true
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "provider_id",
        "from_address",
        "to_addresses",
        "cc_addresses",
        "bcc_addresses",
        "reply_to",
        "subject",
        "html",
        "text_body",
        "attachments_json",
        "headers_json",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSandboxEmails",
    "path": "/v1/sandbox-emails",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSandboxEmails",
    "path": "/v1/sandbox-emails",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSandboxEmails",
    "path": "/v1/sandbox-emails",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSandboxEmails",
    "path": "/v1/sandbox-emails",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "cross_tenant_reference"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSandboxEmails",
    "path": "/v1/sandbox-emails",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSandboxEmails",
    "path": "/v1/sandbox-emails",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "sandbox-emails not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sandbox-emails row.",
      "properties": {
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "to_addresses": {},
        "cc_addresses": {},
        "bcc_addresses": {},
        "reply_to": {
          "type": "string",
          "nullable": true
        },
        "subject": {
          "type": "string",
          "nullable": true
        },
        "html": {
          "type": "string",
          "nullable": true
        },
        "text_body": {
          "type": "string",
          "nullable": true
        },
        "attachments_json": {
          "type": "string",
          "nullable": true
        },
        "headers_json": {
          "type": "string",
          "nullable": true
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "provider_id",
        "from_address",
        "to_addresses",
        "cc_addresses",
        "bcc_addresses",
        "reply_to",
        "subject",
        "html",
        "text_body",
        "attachments_json",
        "headers_json",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "sandbox-emails not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sandbox-emails row.",
      "properties": {
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "to_addresses": {},
        "cc_addresses": {},
        "bcc_addresses": {},
        "reply_to": {
          "type": "string",
          "nullable": true
        },
        "subject": {
          "type": "string",
          "nullable": true
        },
        "html": {
          "type": "string",
          "nullable": true
        },
        "text_body": {
          "type": "string",
          "nullable": true
        },
        "attachments_json": {
          "type": "string",
          "nullable": true
        },
        "headers_json": {
          "type": "string",
          "nullable": true
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "provider_id",
        "from_address",
        "to_addresses",
        "cc_addresses",
        "bcc_addresses",
        "reply_to",
        "subject",
        "html",
        "text_body",
        "attachments_json",
        "headers_json",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "sandbox-emails not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sandbox-emails row.",
      "properties": {
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "to_addresses": {},
        "cc_addresses": {},
        "bcc_addresses": {},
        "reply_to": {
          "type": "string",
          "nullable": true
        },
        "subject": {
          "type": "string",
          "nullable": true
        },
        "html": {
          "type": "string",
          "nullable": true
        },
        "text_body": {
          "type": "string",
          "nullable": true
        },
        "attachments_json": {
          "type": "string",
          "nullable": true
        },
        "headers_json": {
          "type": "string",
          "nullable": true
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "provider_id",
        "from_address",
        "to_addresses",
        "cc_addresses",
        "bcc_addresses",
        "reply_to",
        "subject",
        "html",
        "text_body",
        "attachments_json",
        "headers_json",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "sandbox-emails not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSandboxEmails",
    "path": "/v1/sandbox-emails/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceScheduled",
    "path": "/v1/scheduled",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped scheduled row.",
            "properties": {
              "provider_id": {
                "type": "string",
                "nullable": true
              },
              "from_address": {
                "type": "string",
                "nullable": true
              },
              "to_addresses": {},
              "cc_addresses": {},
              "bcc_addresses": {},
              "reply_to": {
                "type": "string",
                "nullable": true
              },
              "subject": {
                "type": "string",
                "nullable": true
              },
              "html": {
                "type": "string",
                "nullable": true
              },
              "text_body": {
                "type": "string",
                "nullable": true
              },
              "attachments_json": {},
              "template_name": {
                "type": "string",
                "nullable": true
              },
              "template_vars": {},
              "scheduled_at": {
                "type": "string",
                "nullable": true
              },
              "status": {
                "type": "string",
                "nullable": true
              },
              "error": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "provider_id",
              "from_address",
              "to_addresses",
              "cc_addresses",
              "bcc_addresses",
              "reply_to",
              "subject",
              "html",
              "text_body",
              "attachments_json",
              "template_name",
              "template_vars",
              "scheduled_at",
              "status",
              "error",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceScheduled",
    "path": "/v1/scheduled",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceScheduled",
    "path": "/v1/scheduled",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceScheduled",
    "path": "/v1/scheduled",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceScheduled",
    "path": "/v1/scheduled",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped scheduled row.",
      "properties": {
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "to_addresses": {},
        "cc_addresses": {},
        "bcc_addresses": {},
        "reply_to": {
          "type": "string",
          "nullable": true
        },
        "subject": {
          "type": "string",
          "nullable": true
        },
        "html": {
          "type": "string",
          "nullable": true
        },
        "text_body": {
          "type": "string",
          "nullable": true
        },
        "attachments_json": {},
        "template_name": {
          "type": "string",
          "nullable": true
        },
        "template_vars": {},
        "scheduled_at": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "error": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "provider_id",
        "from_address",
        "to_addresses",
        "cc_addresses",
        "bcc_addresses",
        "reply_to",
        "subject",
        "html",
        "text_body",
        "attachments_json",
        "template_name",
        "template_vars",
        "scheduled_at",
        "status",
        "error",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceScheduled",
    "path": "/v1/scheduled",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceScheduled",
    "path": "/v1/scheduled",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceScheduled",
    "path": "/v1/scheduled",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceScheduled",
    "path": "/v1/scheduled",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "cross_tenant_reference"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceScheduled",
    "path": "/v1/scheduled",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceScheduled",
    "path": "/v1/scheduled",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "scheduled not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped scheduled row.",
      "properties": {
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "to_addresses": {},
        "cc_addresses": {},
        "bcc_addresses": {},
        "reply_to": {
          "type": "string",
          "nullable": true
        },
        "subject": {
          "type": "string",
          "nullable": true
        },
        "html": {
          "type": "string",
          "nullable": true
        },
        "text_body": {
          "type": "string",
          "nullable": true
        },
        "attachments_json": {},
        "template_name": {
          "type": "string",
          "nullable": true
        },
        "template_vars": {},
        "scheduled_at": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "error": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "provider_id",
        "from_address",
        "to_addresses",
        "cc_addresses",
        "bcc_addresses",
        "reply_to",
        "subject",
        "html",
        "text_body",
        "attachments_json",
        "template_name",
        "template_vars",
        "scheduled_at",
        "status",
        "error",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "scheduled not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped scheduled row.",
      "properties": {
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "to_addresses": {},
        "cc_addresses": {},
        "bcc_addresses": {},
        "reply_to": {
          "type": "string",
          "nullable": true
        },
        "subject": {
          "type": "string",
          "nullable": true
        },
        "html": {
          "type": "string",
          "nullable": true
        },
        "text_body": {
          "type": "string",
          "nullable": true
        },
        "attachments_json": {},
        "template_name": {
          "type": "string",
          "nullable": true
        },
        "template_vars": {},
        "scheduled_at": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "error": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "provider_id",
        "from_address",
        "to_addresses",
        "cc_addresses",
        "bcc_addresses",
        "reply_to",
        "subject",
        "html",
        "text_body",
        "attachments_json",
        "template_name",
        "template_vars",
        "scheduled_at",
        "status",
        "error",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "scheduled not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped scheduled row.",
      "properties": {
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "to_addresses": {},
        "cc_addresses": {},
        "bcc_addresses": {},
        "reply_to": {
          "type": "string",
          "nullable": true
        },
        "subject": {
          "type": "string",
          "nullable": true
        },
        "html": {
          "type": "string",
          "nullable": true
        },
        "text_body": {
          "type": "string",
          "nullable": true
        },
        "attachments_json": {},
        "template_name": {
          "type": "string",
          "nullable": true
        },
        "template_vars": {},
        "scheduled_at": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "error": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "provider_id",
        "from_address",
        "to_addresses",
        "cc_addresses",
        "bcc_addresses",
        "reply_to",
        "subject",
        "html",
        "text_body",
        "attachments_json",
        "template_name",
        "template_vars",
        "scheduled_at",
        "status",
        "error",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "scheduled not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceScheduled",
    "path": "/v1/scheduled/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSendKeys",
    "path": "/v1/send-keys",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped send-keys row.",
            "properties": {
              "owner_id": {
                "type": "string",
                "nullable": true
              },
              "prefix": {
                "type": "string",
                "nullable": true
              },
              "label": {
                "type": "string",
                "nullable": true
              },
              "last_used_at": {
                "type": "string",
                "nullable": true
              },
              "revoked_at": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "owner_id",
              "prefix",
              "label",
              "last_used_at",
              "revoked_at",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSendKeys",
    "path": "/v1/send-keys",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSendKeys",
    "path": "/v1/send-keys",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSendKeys",
    "path": "/v1/send-keys",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSendKeys",
    "path": "/v1/send-keys",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped send-keys row.",
      "properties": {
        "owner_id": {
          "type": "string",
          "nullable": true
        },
        "prefix": {
          "type": "string",
          "nullable": true
        },
        "label": {
          "type": "string",
          "nullable": true
        },
        "last_used_at": {
          "type": "string",
          "nullable": true
        },
        "revoked_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "owner_id",
        "prefix",
        "label",
        "last_used_at",
        "revoked_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSendKeys",
    "path": "/v1/send-keys",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSendKeys",
    "path": "/v1/send-keys",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSendKeys",
    "path": "/v1/send-keys",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSendKeys",
    "path": "/v1/send-keys",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "cross_tenant_reference"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSendKeys",
    "path": "/v1/send-keys",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSendKeys",
    "path": "/v1/send-keys",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "send-keys not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped send-keys row.",
      "properties": {
        "owner_id": {
          "type": "string",
          "nullable": true
        },
        "prefix": {
          "type": "string",
          "nullable": true
        },
        "label": {
          "type": "string",
          "nullable": true
        },
        "last_used_at": {
          "type": "string",
          "nullable": true
        },
        "revoked_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "owner_id",
        "prefix",
        "label",
        "last_used_at",
        "revoked_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "send-keys not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped send-keys row.",
      "properties": {
        "owner_id": {
          "type": "string",
          "nullable": true
        },
        "prefix": {
          "type": "string",
          "nullable": true
        },
        "label": {
          "type": "string",
          "nullable": true
        },
        "last_used_at": {
          "type": "string",
          "nullable": true
        },
        "revoked_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "owner_id",
        "prefix",
        "label",
        "last_used_at",
        "revoked_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "send-keys not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped send-keys row.",
      "properties": {
        "owner_id": {
          "type": "string",
          "nullable": true
        },
        "prefix": {
          "type": "string",
          "nullable": true
        },
        "label": {
          "type": "string",
          "nullable": true
        },
        "last_used_at": {
          "type": "string",
          "nullable": true
        },
        "revoked_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "owner_id",
        "prefix",
        "label",
        "last_used_at",
        "revoked_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "send-keys not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSendKeys",
    "path": "/v1/send-keys/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "mintSendKey",
    "path": "/v1/send-keys/mint",
    "status": 201,
    "schema": {
      "type": "object",
      "properties": {
        "token": {
          "type": "string"
        },
        "key": {
          "$ref": "#/components/schemas/SendKey"
        }
      },
      "required": [
        "token",
        "key"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "mintSendKey",
    "path": "/v1/send-keys/mint",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "mintSendKey",
    "path": "/v1/send-keys/mint",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "mintSendKey",
    "path": "/v1/send-keys/mint",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "mintSendKey",
    "path": "/v1/send-keys/mint",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "cross_tenant_reference"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "mintSendKey",
    "path": "/v1/send-keys/mint",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "mintSendKey",
    "path": "/v1/send-keys/mint",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "verifySendKey",
    "path": "/v1/send-keys/verify",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "valid": {
          "type": "boolean"
        },
        "authorized": {
          "type": "boolean"
        },
        "key": {
          "$ref": "#/components/schemas/SendKey",
          "nullable": true
        }
      },
      "required": [
        "valid",
        "authorized",
        "key"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "verifySendKey",
    "path": "/v1/send-keys/verify",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "verifySendKey",
    "path": "/v1/send-keys/verify",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "verifySendKey",
    "path": "/v1/send-keys/verify",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "verifySendKey",
    "path": "/v1/send-keys/verify",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "verifySendKey",
    "path": "/v1/send-keys/verify",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped sequence-enrollments row.",
            "properties": {
              "sequence_id": {
                "type": "string",
                "nullable": true
              },
              "contact_email": {
                "type": "string",
                "nullable": true
              },
              "provider_id": {
                "type": "string",
                "nullable": true
              },
              "current_step": {
                "type": "integer"
              },
              "status": {
                "type": "string",
                "nullable": true
              },
              "enrolled_at": {
                "type": "string",
                "nullable": true
              },
              "next_send_at": {
                "type": "string",
                "nullable": true
              },
              "completed_at": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "sequence_id",
              "contact_email",
              "provider_id",
              "current_step",
              "status",
              "enrolled_at",
              "next_send_at",
              "completed_at",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sequence-enrollments row.",
      "properties": {
        "sequence_id": {
          "type": "string",
          "nullable": true
        },
        "contact_email": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "current_step": {
          "type": "integer"
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "enrolled_at": {
          "type": "string",
          "nullable": true
        },
        "next_send_at": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "sequence_id",
        "contact_email",
        "provider_id",
        "current_step",
        "status",
        "enrolled_at",
        "next_send_at",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "cross_tenant_reference"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "sequence-enrollments not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sequence-enrollments row.",
      "properties": {
        "sequence_id": {
          "type": "string",
          "nullable": true
        },
        "contact_email": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "current_step": {
          "type": "integer"
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "enrolled_at": {
          "type": "string",
          "nullable": true
        },
        "next_send_at": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "sequence_id",
        "contact_email",
        "provider_id",
        "current_step",
        "status",
        "enrolled_at",
        "next_send_at",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "sequence-enrollments not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sequence-enrollments row.",
      "properties": {
        "sequence_id": {
          "type": "string",
          "nullable": true
        },
        "contact_email": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "current_step": {
          "type": "integer"
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "enrolled_at": {
          "type": "string",
          "nullable": true
        },
        "next_send_at": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "sequence_id",
        "contact_email",
        "provider_id",
        "current_step",
        "status",
        "enrolled_at",
        "next_send_at",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "sequence-enrollments not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sequence-enrollments row.",
      "properties": {
        "sequence_id": {
          "type": "string",
          "nullable": true
        },
        "contact_email": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "current_step": {
          "type": "integer"
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "enrolled_at": {
          "type": "string",
          "nullable": true
        },
        "next_send_at": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "sequence_id",
        "contact_email",
        "provider_id",
        "current_step",
        "status",
        "enrolled_at",
        "next_send_at",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "sequence-enrollments not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceEnrollments",
    "path": "/v1/sequence-enrollments/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSequenceSteps",
    "path": "/v1/sequence-steps",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped sequence-steps row.",
            "properties": {
              "sequence_id": {
                "type": "string",
                "nullable": true
              },
              "step_number": {
                "type": "integer"
              },
              "delay_hours": {
                "type": "integer"
              },
              "template_name": {
                "type": "string",
                "nullable": true
              },
              "from_address": {
                "type": "string",
                "nullable": true
              },
              "subject_override": {
                "type": "string",
                "nullable": true
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "sequence_id",
              "step_number",
              "delay_hours",
              "template_name",
              "from_address",
              "subject_override",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSequenceSteps",
    "path": "/v1/sequence-steps",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSequenceSteps",
    "path": "/v1/sequence-steps",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSequenceSteps",
    "path": "/v1/sequence-steps",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceSteps",
    "path": "/v1/sequence-steps",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sequence-steps row.",
      "properties": {
        "sequence_id": {
          "type": "string",
          "nullable": true
        },
        "step_number": {
          "type": "integer"
        },
        "delay_hours": {
          "type": "integer"
        },
        "template_name": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "subject_override": {
          "type": "string",
          "nullable": true
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "sequence_id",
        "step_number",
        "delay_hours",
        "template_name",
        "from_address",
        "subject_override",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceSteps",
    "path": "/v1/sequence-steps",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceSteps",
    "path": "/v1/sequence-steps",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceSteps",
    "path": "/v1/sequence-steps",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceSteps",
    "path": "/v1/sequence-steps",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "cross_tenant_reference"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceSteps",
    "path": "/v1/sequence-steps",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequenceSteps",
    "path": "/v1/sequence-steps",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "sequence-steps not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sequence-steps row.",
      "properties": {
        "sequence_id": {
          "type": "string",
          "nullable": true
        },
        "step_number": {
          "type": "integer"
        },
        "delay_hours": {
          "type": "integer"
        },
        "template_name": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "subject_override": {
          "type": "string",
          "nullable": true
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "sequence_id",
        "step_number",
        "delay_hours",
        "template_name",
        "from_address",
        "subject_override",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "sequence-steps not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sequence-steps row.",
      "properties": {
        "sequence_id": {
          "type": "string",
          "nullable": true
        },
        "step_number": {
          "type": "integer"
        },
        "delay_hours": {
          "type": "integer"
        },
        "template_name": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "subject_override": {
          "type": "string",
          "nullable": true
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "sequence_id",
        "step_number",
        "delay_hours",
        "template_name",
        "from_address",
        "subject_override",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "sequence-steps not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sequence-steps row.",
      "properties": {
        "sequence_id": {
          "type": "string",
          "nullable": true
        },
        "step_number": {
          "type": "integer"
        },
        "delay_hours": {
          "type": "integer"
        },
        "template_name": {
          "type": "string",
          "nullable": true
        },
        "from_address": {
          "type": "string",
          "nullable": true
        },
        "subject_override": {
          "type": "string",
          "nullable": true
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "sequence_id",
        "step_number",
        "delay_hours",
        "template_name",
        "from_address",
        "subject_override",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "sequence-steps not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequenceSteps",
    "path": "/v1/sequence-steps/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSequences",
    "path": "/v1/sequences",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped sequences row.",
            "properties": {
              "name": {
                "type": "string",
                "nullable": true
              },
              "description": {
                "type": "string",
                "nullable": true
              },
              "status": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "name",
              "description",
              "status",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSequences",
    "path": "/v1/sequences",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSequences",
    "path": "/v1/sequences",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSequences",
    "path": "/v1/sequences",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequences",
    "path": "/v1/sequences",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sequences row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "description": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "description",
        "status",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequences",
    "path": "/v1/sequences",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequences",
    "path": "/v1/sequences",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequences",
    "path": "/v1/sequences",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequences",
    "path": "/v1/sequences",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSequences",
    "path": "/v1/sequences",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "sequences not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sequences row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "description": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "description",
        "status",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "sequences not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sequences row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "description": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "description",
        "status",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "sequences not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sequences row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "description": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "description",
        "status",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "sequences not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSequences",
    "path": "/v1/sequences/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSources",
    "path": "/v1/sources",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped sources row.",
            "properties": {
              "mailbox_id": {
                "type": "string",
                "nullable": true
              },
              "provider_id": {
                "type": "string",
                "nullable": true
              },
              "type": {
                "type": "string",
                "nullable": true
              },
              "name": {
                "type": "string",
                "nullable": true
              },
              "external_account_id": {
                "type": "string",
                "nullable": true
              },
              "external_mailbox": {
                "type": "string",
                "nullable": true
              },
              "status": {
                "type": "string",
                "nullable": true
              },
              "settings_json": {},
              "provider_snapshot_json": {},
              "last_synced_at": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "mailbox_id",
              "provider_id",
              "type",
              "name",
              "external_account_id",
              "external_mailbox",
              "status",
              "settings_json",
              "provider_snapshot_json",
              "last_synced_at",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSources",
    "path": "/v1/sources",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSources",
    "path": "/v1/sources",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceSources",
    "path": "/v1/sources",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSources",
    "path": "/v1/sources",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sources row.",
      "properties": {
        "mailbox_id": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "type": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "external_account_id": {
          "type": "string",
          "nullable": true
        },
        "external_mailbox": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "settings_json": {},
        "provider_snapshot_json": {},
        "last_synced_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "mailbox_id",
        "provider_id",
        "type",
        "name",
        "external_account_id",
        "external_mailbox",
        "status",
        "settings_json",
        "provider_snapshot_json",
        "last_synced_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSources",
    "path": "/v1/sources",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSources",
    "path": "/v1/sources",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSources",
    "path": "/v1/sources",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSources",
    "path": "/v1/sources",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "cross_tenant_reference"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSources",
    "path": "/v1/sources",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceSources",
    "path": "/v1/sources",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSources",
    "path": "/v1/sources/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSources",
    "path": "/v1/sources/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSources",
    "path": "/v1/sources/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSources",
    "path": "/v1/sources/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "sources not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceSources",
    "path": "/v1/sources/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSources",
    "path": "/v1/sources/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sources row.",
      "properties": {
        "mailbox_id": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "type": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "external_account_id": {
          "type": "string",
          "nullable": true
        },
        "external_mailbox": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "settings_json": {},
        "provider_snapshot_json": {},
        "last_synced_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "mailbox_id",
        "provider_id",
        "type",
        "name",
        "external_account_id",
        "external_mailbox",
        "status",
        "settings_json",
        "provider_snapshot_json",
        "last_synced_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSources",
    "path": "/v1/sources/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSources",
    "path": "/v1/sources/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSources",
    "path": "/v1/sources/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "sources not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceSources",
    "path": "/v1/sources/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSources",
    "path": "/v1/sources/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sources row.",
      "properties": {
        "mailbox_id": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "type": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "external_account_id": {
          "type": "string",
          "nullable": true
        },
        "external_mailbox": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "settings_json": {},
        "provider_snapshot_json": {},
        "last_synced_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "mailbox_id",
        "provider_id",
        "type",
        "name",
        "external_account_id",
        "external_mailbox",
        "status",
        "settings_json",
        "provider_snapshot_json",
        "last_synced_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSources",
    "path": "/v1/sources/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSources",
    "path": "/v1/sources/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSources",
    "path": "/v1/sources/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSources",
    "path": "/v1/sources/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "sources not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSources",
    "path": "/v1/sources/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceSources",
    "path": "/v1/sources/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSources",
    "path": "/v1/sources/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped sources row.",
      "properties": {
        "mailbox_id": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "type": {
          "type": "string",
          "nullable": true
        },
        "name": {
          "type": "string",
          "nullable": true
        },
        "external_account_id": {
          "type": "string",
          "nullable": true
        },
        "external_mailbox": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "settings_json": {},
        "provider_snapshot_json": {},
        "last_synced_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "mailbox_id",
        "provider_id",
        "type",
        "name",
        "external_account_id",
        "external_mailbox",
        "status",
        "settings_json",
        "provider_snapshot_json",
        "last_synced_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSources",
    "path": "/v1/sources/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSources",
    "path": "/v1/sources/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSources",
    "path": "/v1/sources/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSources",
    "path": "/v1/sources/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "sources not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSources",
    "path": "/v1/sources/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceSources",
    "path": "/v1/sources/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceTemplates",
    "path": "/v1/templates",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped templates row.",
            "properties": {
              "name": {
                "type": "string",
                "nullable": true
              },
              "subject_template": {
                "type": "string",
                "nullable": true
              },
              "html_template": {
                "type": "string",
                "nullable": true
              },
              "text_template": {
                "type": "string",
                "nullable": true
              },
              "metadata": {},
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "name",
              "subject_template",
              "html_template",
              "text_template",
              "metadata",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceTemplates",
    "path": "/v1/templates",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceTemplates",
    "path": "/v1/templates",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceTemplates",
    "path": "/v1/templates",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceTemplates",
    "path": "/v1/templates",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped templates row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "subject_template": {
          "type": "string",
          "nullable": true
        },
        "html_template": {
          "type": "string",
          "nullable": true
        },
        "text_template": {
          "type": "string",
          "nullable": true
        },
        "metadata": {},
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "subject_template",
        "html_template",
        "text_template",
        "metadata",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceTemplates",
    "path": "/v1/templates",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceTemplates",
    "path": "/v1/templates",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceTemplates",
    "path": "/v1/templates",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceTemplates",
    "path": "/v1/templates",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceTemplates",
    "path": "/v1/templates",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "templates not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped templates row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "subject_template": {
          "type": "string",
          "nullable": true
        },
        "html_template": {
          "type": "string",
          "nullable": true
        },
        "text_template": {
          "type": "string",
          "nullable": true
        },
        "metadata": {},
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "subject_template",
        "html_template",
        "text_template",
        "metadata",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "templates not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped templates row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "subject_template": {
          "type": "string",
          "nullable": true
        },
        "html_template": {
          "type": "string",
          "nullable": true
        },
        "text_template": {
          "type": "string",
          "nullable": true
        },
        "metadata": {},
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "subject_template",
        "html_template",
        "text_template",
        "metadata",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "templates not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped templates row.",
      "properties": {
        "name": {
          "type": "string",
          "nullable": true
        },
        "subject_template": {
          "type": "string",
          "nullable": true
        },
        "html_template": {
          "type": "string",
          "nullable": true
        },
        "text_template": {
          "type": "string",
          "nullable": true
        },
        "metadata": {},
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "name",
        "subject_template",
        "html_template",
        "text_template",
        "metadata",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "templates not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTemplates",
    "path": "/v1/templates/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenants",
    "path": "/v1/tenants",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "tenants": {
          "type": "array",
          "items": {
            "$ref": "#/components/schemas/TenantMembershipSummary"
          }
        }
      },
      "required": [
        "tenants"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenants",
    "path": "/v1/tenants",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenants",
    "path": "/v1/tenants",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenants",
    "path": "/v1/tenants",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenant",
    "path": "/v1/tenants",
    "status": 201,
    "schema": {
      "type": "object",
      "properties": {
        "tenant": {
          "$ref": "#/components/schemas/Tenant"
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "admin",
            "member",
            "viewer"
          ]
        }
      },
      "required": [
        "tenant",
        "role"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenant",
    "path": "/v1/tenants",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenant",
    "path": "/v1/tenants",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenant",
    "path": "/v1/tenants",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenant",
    "path": "/v1/tenants",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenant",
    "path": "/v1/tenants",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenant",
    "path": "/v1/tenants",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "suspendTenant",
    "path": "/v1/tenants/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "suspended": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string",
          "format": "uuid"
        }
      },
      "required": [
        "suspended",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "suspendTenant",
    "path": "/v1/tenants/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "suspendTenant",
    "path": "/v1/tenants/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "suspendTenant",
    "path": "/v1/tenants/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "organization not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "organization not found"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "not_found"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "suspendTenant",
    "path": "/v1/tenants/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getTenant",
    "path": "/v1/tenants/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "tenant": {
          "$ref": "#/components/schemas/Tenant"
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "admin",
            "member",
            "viewer"
          ]
        }
      },
      "required": [
        "tenant"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getTenant",
    "path": "/v1/tenants/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getTenant",
    "path": "/v1/tenants/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getTenant",
    "path": "/v1/tenants/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "organization not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "organization not found"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "not_found"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getTenant",
    "path": "/v1/tenants/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateTenant",
    "path": "/v1/tenants/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "tenant": {
          "$ref": "#/components/schemas/Tenant"
        }
      },
      "required": [
        "tenant"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateTenant",
    "path": "/v1/tenants/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateTenant",
    "path": "/v1/tenants/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateTenant",
    "path": "/v1/tenants/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateTenant",
    "path": "/v1/tenants/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "organization not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "organization not found"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "not_found"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateTenant",
    "path": "/v1/tenants/{id}",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateTenant",
    "path": "/v1/tenants/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateTenant",
    "path": "/v1/tenants/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceTenant",
    "path": "/v1/tenants/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "tenant": {
          "$ref": "#/components/schemas/Tenant"
        }
      },
      "required": [
        "tenant"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceTenant",
    "path": "/v1/tenants/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceTenant",
    "path": "/v1/tenants/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceTenant",
    "path": "/v1/tenants/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceTenant",
    "path": "/v1/tenants/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "organization not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "organization not found"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "not_found"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceTenant",
    "path": "/v1/tenants/{id}",
    "status": 409,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceTenant",
    "path": "/v1/tenants/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceTenant",
    "path": "/v1/tenants/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenantInvites",
    "path": "/v1/tenants/{id}/invites",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "invites": {
          "type": "array",
          "items": {
            "$ref": "#/components/schemas/Invitation"
          }
        }
      },
      "required": [
        "invites"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenantInvites",
    "path": "/v1/tenants/{id}/invites",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenantInvites",
    "path": "/v1/tenants/{id}/invites",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenantInvites",
    "path": "/v1/tenants/{id}/invites",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantInvite",
    "path": "/v1/tenants/{id}/invites",
    "status": 201,
    "schema": {
      "type": "object",
      "properties": {
        "invited": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "email": {
          "type": "string",
          "format": "email"
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "admin",
            "member"
          ]
        },
        "expires_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "invited",
        "email",
        "role",
        "expires_at"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantInvite",
    "path": "/v1/tenants/{id}/invites",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantInvite",
    "path": "/v1/tenants/{id}/invites",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantInvite",
    "path": "/v1/tenants/{id}/invites",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantInvite",
    "path": "/v1/tenants/{id}/invites",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantInvite",
    "path": "/v1/tenants/{id}/invites",
    "status": 429,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "too many requests"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "rate_limited"
          ]
        },
        "retry_after": {
          "type": "number",
          "minimum": 0
        }
      },
      "required": [
        "error",
        "reason",
        "retry_after"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createTenantInvite",
    "path": "/v1/tenants/{id}/invites",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenantMembers",
    "path": "/v1/tenants/{id}/members",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "members": {
          "type": "array",
          "items": {
            "$ref": "#/components/schemas/Membership"
          }
        }
      },
      "required": [
        "members"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenantMembers",
    "path": "/v1/tenants/{id}/members",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenantMembers",
    "path": "/v1/tenants/{id}/members",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listTenantMembers",
    "path": "/v1/tenants/{id}/members",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceTriage",
    "path": "/v1/triage",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped triage row.",
            "properties": {
              "email_id": {
                "type": "string",
                "nullable": true
              },
              "inbound_email_id": {
                "type": "string",
                "nullable": true
              },
              "label": {
                "type": "string",
                "nullable": true
              },
              "priority": {
                "type": "integer"
              },
              "summary": {
                "type": "string",
                "nullable": true
              },
              "sentiment": {
                "type": "string",
                "nullable": true
              },
              "draft_reply": {
                "type": "string",
                "nullable": true
              },
              "confidence": {
                "type": "number"
              },
              "model": {
                "type": "string",
                "nullable": true
              },
              "triaged_at": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "email_id",
              "inbound_email_id",
              "label",
              "priority",
              "summary",
              "sentiment",
              "draft_reply",
              "confidence",
              "model",
              "triaged_at",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceTriage",
    "path": "/v1/triage",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceTriage",
    "path": "/v1/triage",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceTriage",
    "path": "/v1/triage",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceTriage",
    "path": "/v1/triage",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped triage row.",
      "properties": {
        "email_id": {
          "type": "string",
          "nullable": true
        },
        "inbound_email_id": {
          "type": "string",
          "nullable": true
        },
        "label": {
          "type": "string",
          "nullable": true
        },
        "priority": {
          "type": "integer"
        },
        "summary": {
          "type": "string",
          "nullable": true
        },
        "sentiment": {
          "type": "string",
          "nullable": true
        },
        "draft_reply": {
          "type": "string",
          "nullable": true
        },
        "confidence": {
          "type": "number"
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "triaged_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "email_id",
        "inbound_email_id",
        "label",
        "priority",
        "summary",
        "sentiment",
        "draft_reply",
        "confidence",
        "model",
        "triaged_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceTriage",
    "path": "/v1/triage",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceTriage",
    "path": "/v1/triage",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceTriage",
    "path": "/v1/triage",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceTriage",
    "path": "/v1/triage",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceTriage",
    "path": "/v1/triage",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "triage not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped triage row.",
      "properties": {
        "email_id": {
          "type": "string",
          "nullable": true
        },
        "inbound_email_id": {
          "type": "string",
          "nullable": true
        },
        "label": {
          "type": "string",
          "nullable": true
        },
        "priority": {
          "type": "integer"
        },
        "summary": {
          "type": "string",
          "nullable": true
        },
        "sentiment": {
          "type": "string",
          "nullable": true
        },
        "draft_reply": {
          "type": "string",
          "nullable": true
        },
        "confidence": {
          "type": "number"
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "triaged_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "email_id",
        "inbound_email_id",
        "label",
        "priority",
        "summary",
        "sentiment",
        "draft_reply",
        "confidence",
        "model",
        "triaged_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "triage not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped triage row.",
      "properties": {
        "email_id": {
          "type": "string",
          "nullable": true
        },
        "inbound_email_id": {
          "type": "string",
          "nullable": true
        },
        "label": {
          "type": "string",
          "nullable": true
        },
        "priority": {
          "type": "integer"
        },
        "summary": {
          "type": "string",
          "nullable": true
        },
        "sentiment": {
          "type": "string",
          "nullable": true
        },
        "draft_reply": {
          "type": "string",
          "nullable": true
        },
        "confidence": {
          "type": "number"
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "triaged_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "email_id",
        "inbound_email_id",
        "label",
        "priority",
        "summary",
        "sentiment",
        "draft_reply",
        "confidence",
        "model",
        "triaged_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "triage not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped triage row.",
      "properties": {
        "email_id": {
          "type": "string",
          "nullable": true
        },
        "inbound_email_id": {
          "type": "string",
          "nullable": true
        },
        "label": {
          "type": "string",
          "nullable": true
        },
        "priority": {
          "type": "integer"
        },
        "summary": {
          "type": "string",
          "nullable": true
        },
        "sentiment": {
          "type": "string",
          "nullable": true
        },
        "draft_reply": {
          "type": "string",
          "nullable": true
        },
        "confidence": {
          "type": "number"
        },
        "model": {
          "type": "string",
          "nullable": true
        },
        "triaged_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "email_id",
        "inbound_email_id",
        "label",
        "priority",
        "summary",
        "sentiment",
        "draft_reply",
        "confidence",
        "model",
        "triaged_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "triage not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceTriage",
    "path": "/v1/triage/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceWarming",
    "path": "/v1/warming",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped warming row.",
            "properties": {
              "domain": {
                "type": "string",
                "nullable": true
              },
              "provider_id": {
                "type": "string",
                "nullable": true
              },
              "target_daily_volume": {
                "type": "integer"
              },
              "start_date": {
                "type": "string",
                "nullable": true
              },
              "status": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "domain",
              "provider_id",
              "target_daily_volume",
              "start_date",
              "status",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceWarming",
    "path": "/v1/warming",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceWarming",
    "path": "/v1/warming",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceWarming",
    "path": "/v1/warming",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWarming",
    "path": "/v1/warming",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped warming row.",
      "properties": {
        "domain": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "target_daily_volume": {
          "type": "integer"
        },
        "start_date": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "domain",
        "provider_id",
        "target_daily_volume",
        "start_date",
        "status",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWarming",
    "path": "/v1/warming",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWarming",
    "path": "/v1/warming",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWarming",
    "path": "/v1/warming",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWarming",
    "path": "/v1/warming",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "enum": [
            "cross_tenant_reference"
          ]
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWarming",
    "path": "/v1/warming",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWarming",
    "path": "/v1/warming",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "warming not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped warming row.",
      "properties": {
        "domain": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "target_daily_volume": {
          "type": "integer"
        },
        "start_date": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "domain",
        "provider_id",
        "target_daily_volume",
        "start_date",
        "status",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "warming not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped warming row.",
      "properties": {
        "domain": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "target_daily_volume": {
          "type": "integer"
        },
        "start_date": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "domain",
        "provider_id",
        "target_daily_volume",
        "start_date",
        "status",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "warming not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped warming row.",
      "properties": {
        "domain": {
          "type": "string",
          "nullable": true
        },
        "provider_id": {
          "type": "string",
          "nullable": true
        },
        "target_daily_volume": {
          "type": "integer"
        },
        "start_date": {
          "type": "string",
          "nullable": true
        },
        "status": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "domain",
        "provider_id",
        "target_daily_volume",
        "start_date",
        "status",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 404,
    "schema": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "enum": [
                "warming not found"
              ]
            }
          },
          "required": [
            "error"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "error": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "enum": [
                "cross_tenant_reference"
              ]
            }
          },
          "required": [
            "error",
            "reason"
          ]
        }
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWarming",
    "path": "/v1/warming/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceWebhookReceipts",
    "path": "/v1/webhook-receipts",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Tenant-scoped webhook-receipts row.",
            "properties": {
              "provider": {
                "type": "string",
                "nullable": true
              },
              "event_id": {
                "type": "string",
                "nullable": true
              },
              "resource_id": {
                "type": "string",
                "nullable": true
              },
              "completed_at": {
                "type": "string",
                "nullable": true
              },
              "id": {
                "type": "string"
              },
              "tenant_id": {
                "type": "string",
                "format": "uuid"
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "id",
              "tenant_id",
              "provider",
              "event_id",
              "resource_id",
              "completed_at",
              "created_at",
              "updated_at"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceWebhookReceipts",
    "path": "/v1/webhook-receipts",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceWebhookReceipts",
    "path": "/v1/webhook-receipts",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "listResourceWebhookReceipts",
    "path": "/v1/webhook-receipts",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWebhookReceipts",
    "path": "/v1/webhook-receipts",
    "status": 201,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped webhook-receipts row.",
      "properties": {
        "provider": {
          "type": "string",
          "nullable": true
        },
        "event_id": {
          "type": "string",
          "nullable": true
        },
        "resource_id": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "provider",
        "event_id",
        "resource_id",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWebhookReceipts",
    "path": "/v1/webhook-receipts",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWebhookReceipts",
    "path": "/v1/webhook-receipts",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWebhookReceipts",
    "path": "/v1/webhook-receipts",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWebhookReceipts",
    "path": "/v1/webhook-receipts",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "createResourceWebhookReceipts",
    "path": "/v1/webhook-receipts",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "deleted",
        "id"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "webhook-receipts not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "DELETE",
    "operationId": "deleteResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped webhook-receipts row.",
      "properties": {
        "provider": {
          "type": "string",
          "nullable": true
        },
        "event_id": {
          "type": "string",
          "nullable": true
        },
        "resource_id": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "provider",
        "event_id",
        "resource_id",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "webhook-receipts not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "GET",
    "operationId": "getResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped webhook-receipts row.",
      "properties": {
        "provider": {
          "type": "string",
          "nullable": true
        },
        "event_id": {
          "type": "string",
          "nullable": true
        },
        "resource_id": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "provider",
        "event_id",
        "resource_id",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "webhook-receipts not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PATCH",
    "operationId": "updateResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 200,
    "schema": {
      "type": "object",
      "description": "Tenant-scoped webhook-receipts row.",
      "properties": {
        "provider": {
          "type": "string",
          "nullable": true
        },
        "event_id": {
          "type": "string",
          "nullable": true
        },
        "resource_id": {
          "type": "string",
          "nullable": true
        },
        "completed_at": {
          "type": "string",
          "nullable": true
        },
        "id": {
          "type": "string"
        },
        "tenant_id": {
          "type": "string",
          "format": "uuid"
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "id",
        "tenant_id",
        "provider",
        "event_id",
        "resource_id",
        "completed_at",
        "created_at",
        "updated_at"
      ],
      "additionalProperties": true
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 401,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 403,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error",
        "reason"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 404,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "webhook-receipts not found"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "PUT",
    "operationId": "replaceResourceWebhookReceipts",
    "path": "/v1/webhook-receipts/{id}",
    "status": 500,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "internal error"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "receiveResendInboundWebhook",
    "path": "/v1/webhooks/resend-inbound",
    "status": 200,
    "schema": {
      "$ref": "#/components/schemas/WebhookReceipt"
    }
  },
  {
    "method": "POST",
    "operationId": "receiveResendInboundWebhook",
    "path": "/v1/webhooks/resend-inbound",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "receiveResendInboundWebhook",
    "path": "/v1/webhooks/resend-inbound",
    "status": 401,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "POST",
    "operationId": "receiveResendInboundWebhook",
    "path": "/v1/webhooks/resend-inbound",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "receiveResendInboundWebhook",
    "path": "/v1/webhooks/resend-inbound",
    "status": 503,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "POST",
    "operationId": "receiveSesInboundWebhook",
    "path": "/v1/webhooks/ses-inbound",
    "status": 200,
    "schema": {
      "$ref": "#/components/schemas/WebhookReceipt"
    }
  },
  {
    "method": "POST",
    "operationId": "receiveSesInboundWebhook",
    "path": "/v1/webhooks/ses-inbound",
    "status": 400,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "receiveSesInboundWebhook",
    "path": "/v1/webhooks/ses-inbound",
    "status": 401,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "POST",
    "operationId": "receiveSesInboundWebhook",
    "path": "/v1/webhooks/ses-inbound",
    "status": 413,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "error": {
          "type": "string",
          "enum": [
            "request body too large"
          ]
        }
      },
      "required": [
        "error"
      ]
    }
  },
  {
    "method": "POST",
    "operationId": "receiveSesInboundWebhook",
    "path": "/v1/webhooks/ses-inbound",
    "status": 503,
    "schema": {
      "$ref": "#/components/schemas/ErrorResponse"
    }
  },
  {
    "method": "GET",
    "operationId": "getVersion",
    "path": "/version",
    "status": 200,
    "schema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "ok"
          ]
        },
        "version": {
          "type": "string"
        },
        "mode": {
          "type": "string",
          "enum": [
            "self_hosted"
          ]
        },
        "name": {
          "type": "string",
          "enum": [
            "emails"
          ]
        }
      },
      "required": [
        "status",
        "version",
        "mode",
        "name"
      ]
    }
  }
];

export const SELF_HOSTED_RESPONSE_COMPONENTS: Readonly<Record<string, unknown>> = {
  "Address": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "email": {
        "type": "string"
      },
      "domain": {
        "type": "string",
        "nullable": true
      },
      "display_name": {
        "type": "string",
        "nullable": true
      },
      "status": {
        "type": "string"
      },
      "verified": {
        "type": "boolean"
      },
      "daily_quota": {
        "type": "integer",
        "nullable": true
      },
      "owner_id": {
        "type": "string",
        "nullable": true
      },
      "administrator_id": {
        "type": "string",
        "nullable": true
      },
      "domain_id": {
        "type": "string",
        "nullable": true
      },
      "receive_strategy": {
        "type": "string",
        "nullable": true
      },
      "forward_to": {
        "type": "string",
        "nullable": true
      },
      "routing_rule_id": {
        "type": "string",
        "nullable": true
      },
      "provisioning_status": {
        "type": "string"
      },
      "last_validated_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "last_error": {
        "type": "string",
        "nullable": true
      },
      "next_check_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      },
      "updated_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "id",
      "email",
      "status",
      "created_at",
      "updated_at"
    ]
  },
  "ApiKeyMetadata": {
    "type": "object",
    "properties": {
      "kid": {
        "type": "string"
      },
      "app": {
        "type": "string"
      },
      "agent": {
        "type": "string",
        "nullable": true
      },
      "scopes": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "issued_at": {
        "type": "string",
        "format": "date-time"
      },
      "expires_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "revoked_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "last_used_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "created_by_user_id": {
        "type": "string",
        "format": "uuid",
        "nullable": true
      }
    },
    "required": [
      "kid",
      "app",
      "agent",
      "scopes",
      "issued_at",
      "expires_at",
      "revoked_at",
      "last_used_at",
      "created_by_user_id"
    ]
  },
  "AttachmentBatchMeta": {
    "type": "object",
    "additionalProperties": false,
    "description": "Per-message attachment metadata (batch mode). content_base64 is excluded.",
    "properties": {
      "attachment_index": {
        "type": "integer",
        "minimum": 0
      },
      "filename": {
        "type": "string",
        "nullable": true
      },
      "content_type": {
        "type": "string",
        "nullable": true
      },
      "size_bytes": {
        "type": "integer",
        "nullable": true,
        "minimum": 0
      },
      "sha256": {
        "type": "string",
        "nullable": true
      },
      "content_available": {
        "type": "boolean",
        "description": "True only when stored payload bytes are canonical base64, decode within the server limit, and match a valid declared byte size; false for metadata-only or malformed stored payloads."
      }
    },
    "required": [
      "attachment_index",
      "filename",
      "content_type",
      "size_bytes",
      "sha256",
      "content_available"
    ]
  },
  "AttachmentContent": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "filename": {
        "type": "string"
      },
      "content_type": {
        "type": "string",
        "description": "Validated MIME type"
      },
      "size": {
        "type": "integer",
        "minimum": 0,
        "maximum": 26214400
      },
      "content_base64": {
        "type": "string",
        "description": "Canonical base64; authenticated response only"
      }
    },
    "required": [
      "filename",
      "content_type",
      "size",
      "content_base64"
    ]
  },
  "AttachmentInventoryItem": {
    "type": "object",
    "additionalProperties": false,
    "description": "One machine-readable attachment-metadata row. Never carries content_base64; payload bytes come from GET /v1/messages/{id}/attachments/{index}.",
    "properties": {
      "message_id": {
        "type": "string"
      },
      "attachment_index": {
        "type": "integer",
        "minimum": 0,
        "description": "0-based position in the message's attachments array; the stable id accepted by GET /v1/messages/{id}/attachments/{index}."
      },
      "filename": {
        "type": "string",
        "nullable": true
      },
      "content_type": {
        "type": "string",
        "nullable": true
      },
      "size_bytes": {
        "type": "integer",
        "nullable": true,
        "minimum": 0
      },
      "sha256": {
        "type": "string",
        "nullable": true,
        "description": "Content checksum when stored."
      },
      "content_available": {
        "type": "boolean",
        "description": "True only when stored payload bytes are canonical base64, decode within the server limit, and match a valid declared byte size, so GET /v1/messages/{id}/attachments/{index} can return them; false answers 409 attachment_content_unavailable."
      },
      "direction": {
        "type": "string",
        "nullable": true,
        "enum": [
          "inbound",
          "outbound",
          null
        ]
      },
      "received_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      }
    },
    "required": [
      "message_id",
      "attachment_index",
      "filename",
      "content_type",
      "size_bytes",
      "sha256",
      "content_available",
      "direction",
      "received_at"
    ]
  },
  "AttachmentMeta": {
    "type": "object",
    "additionalProperties": true,
    "description": "Per-message attachment metadata. Historical rows may be partial, but known fields remain type-checked and content_base64 is excluded.",
    "properties": {
      "filename": {
        "type": "string",
        "nullable": true
      },
      "content_type": {
        "type": "string",
        "nullable": true
      },
      "size": {
        "oneOf": [
          {
            "type": "integer",
            "minimum": 0
          },
          {
            "type": "string"
          }
        ],
        "nullable": true
      },
      "sha256": {
        "type": "string",
        "nullable": true
      },
      "content_available": {
        "type": "boolean",
        "description": "True when the authenticated attachment-content route can return bytes, false when metadata exists without retrievable content; omitted by older serves."
      }
    }
  },
  "AttachmentRepairSummary": {
    "type": "object",
    "additionalProperties": false,
    "description": "Tenant-scoped checkpoint ledger. inventory_total is the exact count of attachment payloads missing at manifest creation; already-present payloads are excluded. Attachment outcomes satisfy repaired + would_repair + unavailable + pending = inventory_total; entry_* outcomes satisfy the equivalent entry_total invariant. operator_action is the retry- or budget-exhausted subset of unavailable, and retrying is the attempted subset of pending. No source keys, recipients, error details, or payload bytes are returned.",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "apply": {
        "type": "boolean"
      },
      "status": {
        "type": "string",
        "enum": [
          "pending",
          "completed"
        ]
      },
      "entry_total": {
        "type": "integer",
        "minimum": 1,
        "maximum": 200
      },
      "inventory_total": {
        "type": "integer",
        "minimum": 1,
        "description": "Attachment payloads missing at manifest creation."
      },
      "repaired": {
        "type": "integer",
        "minimum": 0
      },
      "would_repair": {
        "type": "integer",
        "minimum": 0
      },
      "unavailable": {
        "type": "integer",
        "minimum": 0
      },
      "operator_action": {
        "type": "integer",
        "minimum": 0,
        "description": "Retry- or budget-exhausted attachment payloads requiring operator action; a subset of unavailable."
      },
      "pending": {
        "type": "integer",
        "minimum": 0
      },
      "retrying": {
        "type": "integer",
        "minimum": 0
      },
      "entry_repaired": {
        "type": "integer",
        "minimum": 0
      },
      "entry_would_repair": {
        "type": "integer",
        "minimum": 0
      },
      "entry_unavailable": {
        "type": "integer",
        "minimum": 0
      },
      "entry_operator_action": {
        "type": "integer",
        "minimum": 0,
        "description": "Retry- or budget-exhausted manifest entries requiring operator action; a subset of entry_unavailable."
      },
      "entry_pending": {
        "type": "integer",
        "minimum": 0
      },
      "entry_retrying": {
        "type": "integer",
        "minimum": 0
      },
      "attempts": {
        "type": "integer",
        "minimum": 0
      },
      "checkpoint": {
        "type": "integer",
        "minimum": 0
      },
      "byte_budget": {
        "type": "integer",
        "minimum": 1,
        "description": "Durable source-byte budget for this repair run."
      },
      "bytes_consumed": {
        "type": "integer",
        "minimum": 0,
        "description": "Source bytes durably charged to this run."
      },
      "time_budget_ms": {
        "type": "integer",
        "minimum": 1,
        "description": "Wall-clock budget assigned when the run was created."
      },
      "deadline_at": {
        "type": "string",
        "format": "date-time"
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      },
      "updated_at": {
        "type": "string",
        "format": "date-time"
      },
      "completed_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      }
    },
    "required": [
      "id",
      "apply",
      "status",
      "entry_total",
      "inventory_total",
      "repaired",
      "would_repair",
      "unavailable",
      "operator_action",
      "pending",
      "retrying",
      "entry_repaired",
      "entry_would_repair",
      "entry_unavailable",
      "entry_operator_action",
      "entry_pending",
      "entry_retrying",
      "attempts",
      "checkpoint",
      "byte_budget",
      "bytes_consumed",
      "time_budget_ms",
      "deadline_at",
      "created_at",
      "updated_at",
      "completed_at"
    ]
  },
  "AttachmentUnavailableError": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "error": {
        "type": "string"
      },
      "code": {
        "type": "string",
        "enum": [
          "attachment_content_unavailable"
        ]
      },
      "attachment": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "filename": {
            "type": "string"
          },
          "content_type": {
            "type": "string"
          },
          "size": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          }
        },
        "required": [
          "filename",
          "content_type",
          "size"
        ]
      }
    },
    "required": [
      "error",
      "code",
      "attachment"
    ]
  },
  "Domain": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "domain": {
        "type": "string"
      },
      "status": {
        "type": "string"
      },
      "provider": {
        "type": "string",
        "nullable": true
      },
      "verified": {
        "type": "boolean"
      },
      "notes": {
        "type": "string",
        "nullable": true
      },
      "provisioning_status": {
        "type": "string"
      },
      "purchase_provider": {
        "type": "string",
        "nullable": true
      },
      "dns_provider": {
        "type": "string"
      },
      "send_provider": {
        "type": "string",
        "nullable": true
      },
      "cf_zone_id": {
        "type": "string",
        "nullable": true
      },
      "registrar": {
        "type": "string",
        "nullable": true
      },
      "nameservers_json": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "mail_from_domain": {
        "type": "string",
        "nullable": true
      },
      "last_error": {
        "type": "string",
        "nullable": true
      },
      "next_check_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      },
      "updated_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "id",
      "domain",
      "status",
      "verified",
      "created_at",
      "updated_at"
    ]
  },
  "EmailIdentity": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "email": {
        "type": "string",
        "format": "email"
      },
      "is_primary": {
        "type": "boolean"
      },
      "verified": {
        "type": "boolean"
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "id",
      "email",
      "is_primary",
      "verified"
    ]
  },
  "ErrorResponse": {
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "error": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "error"
    ]
  },
  "Invitation": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "email": {
        "type": "string",
        "format": "email"
      },
      "role": {
        "type": "string",
        "enum": [
          "owner",
          "admin",
          "member",
          "viewer"
        ]
      },
      "expires_at": {
        "type": "string",
        "format": "date-time"
      },
      "accepted_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "id",
      "email",
      "role",
      "expires_at",
      "accepted_at",
      "created_at"
    ]
  },
  "Mailbox": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "address": {
        "type": "string"
      },
      "display_name": {
        "type": "string",
        "nullable": true
      },
      "status": {
        "type": "string"
      },
      "total": {
        "type": "integer"
      },
      "unread": {
        "type": "integer"
      }
    },
    "required": [
      "id",
      "address",
      "display_name",
      "status",
      "total",
      "unread"
    ]
  },
  "Membership": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "user_id": {
        "type": "string",
        "format": "uuid"
      },
      "email": {
        "type": "string",
        "format": "email"
      },
      "name": {
        "type": "string",
        "nullable": true
      },
      "role": {
        "type": "string",
        "enum": [
          "owner",
          "admin",
          "member",
          "viewer"
        ]
      },
      "status": {
        "type": "string"
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "id",
      "user_id",
      "email",
      "name",
      "role",
      "status",
      "created_at"
    ]
  },
  "MembershipSummary": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "role": {
        "type": "string",
        "enum": [
          "owner",
          "admin",
          "member",
          "viewer"
        ]
      },
      "status": {
        "type": "string"
      }
    },
    "required": [
      "id",
      "role",
      "status"
    ]
  },
  "Message": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "direction": {
        "type": "string",
        "description": "outbound | inbound"
      },
      "from_addr": {
        "type": "string"
      },
      "to_addrs": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "cc_addrs": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "subject": {
        "type": "string",
        "nullable": true
      },
      "body_text": {
        "type": "string",
        "nullable": true
      },
      "body_html": {
        "type": "string",
        "nullable": true
      },
      "status": {
        "type": "string"
      },
      "provider_message_id": {
        "type": "string",
        "nullable": true
      },
      "message_id": {
        "type": "string",
        "nullable": true,
        "description": "RFC 5322 Message-ID"
      },
      "in_reply_to": {
        "type": "string",
        "nullable": true
      },
      "received_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true,
        "description": "Original receipt time (inbound)"
      },
      "is_read": {
        "type": "boolean"
      },
      "is_starred": {
        "type": "boolean"
      },
      "labels": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "headers": {
        "type": "object",
        "additionalProperties": true
      },
      "attachments": {
        "type": "array",
        "description": "Per-attachment metadata (filename, content_type, size) plus content_available — true when GET /v1/messages/{id}/attachments/{index} can return bytes, false for metadata-only rows such as legacy imports. content_base64 is never included here.",
        "items": {
          "$ref": "#/components/schemas/AttachmentMeta",
          "nullable": true
        }
      },
      "source_id": {
        "type": "string",
        "nullable": true,
        "description": "Stable upstream id used for idempotent upsert"
      },
      "send_state": {
        "type": "string",
        "description": "none | pending | sending | sent | failed | uncertain | blocked | cancelled"
      },
      "send_started_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      },
      "updated_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "id",
      "direction",
      "from_addr",
      "to_addrs",
      "cc_addrs",
      "subject",
      "body_text",
      "body_html",
      "status",
      "provider_message_id",
      "message_id",
      "in_reply_to",
      "received_at",
      "is_read",
      "is_starred",
      "labels",
      "headers",
      "attachments",
      "source_id",
      "send_state",
      "send_started_at",
      "created_at",
      "updated_at"
    ]
  },
  "MessageCounts": {
    "type": "object",
    "properties": {
      "inbox": {
        "type": "integer",
        "minimum": 0
      },
      "unread": {
        "type": "integer",
        "minimum": 0
      },
      "starred": {
        "type": "integer",
        "minimum": 0
      },
      "sent": {
        "type": "integer",
        "minimum": 0
      },
      "archived": {
        "type": "integer",
        "minimum": 0
      },
      "spam": {
        "type": "integer",
        "minimum": 0
      },
      "trash": {
        "type": "integer",
        "minimum": 0
      },
      "total": {
        "type": "integer",
        "minimum": 0
      },
      "latest_received_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      }
    },
    "required": [
      "inbox",
      "unread",
      "starred",
      "sent",
      "archived",
      "spam",
      "trash",
      "total",
      "latest_received_at"
    ]
  },
  "MessageListItem": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "direction": {
        "type": "string",
        "description": "outbound | inbound"
      },
      "from_addr": {
        "type": "string"
      },
      "to_addrs": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "cc_addrs": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "subject": {
        "type": "string",
        "nullable": true
      },
      "snippet": {
        "type": "string",
        "nullable": true,
        "description": "Short text preview (<=140 chars); full bodies are available only from GET /v1/messages/{id}."
      },
      "status": {
        "type": "string"
      },
      "provider_message_id": {
        "type": "string",
        "nullable": true
      },
      "message_id": {
        "type": "string",
        "nullable": true,
        "description": "RFC 5322 Message-ID"
      },
      "in_reply_to": {
        "type": "string",
        "nullable": true
      },
      "received_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true,
        "description": "Original receipt time (inbound)"
      },
      "is_read": {
        "type": "boolean"
      },
      "is_starred": {
        "type": "boolean"
      },
      "labels": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "attachment_count": {
        "type": "integer",
        "description": "Attachment count; metadata and payloads come from GET /v1/messages/{id} and the attachment endpoints."
      },
      "source_id": {
        "type": "string",
        "nullable": true,
        "description": "Stable upstream id used for idempotent upsert"
      },
      "send_state": {
        "type": "string",
        "description": "none | pending | sending | sent | failed | uncertain | blocked | cancelled"
      },
      "send_started_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      },
      "updated_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "id",
      "direction",
      "from_addr",
      "to_addrs",
      "cc_addrs",
      "subject",
      "snippet",
      "status",
      "provider_message_id",
      "message_id",
      "in_reply_to",
      "received_at",
      "is_read",
      "is_starred",
      "labels",
      "attachment_count",
      "source_id",
      "send_state",
      "send_started_at",
      "created_at",
      "updated_at"
    ]
  },
  "SendIntentCancellation": {
    "type": "object",
    "properties": {
      "outcome": {
        "type": "string",
        "enum": [
          "tombstoned",
          "cancelled",
          "reconciliation_required"
        ]
      },
      "tombstoned": {
        "type": "boolean",
        "enum": [
          true
        ]
      },
      "reconciliation_required": {
        "type": "boolean"
      },
      "message": {
        "$ref": "#/components/schemas/SendIntentMessage",
        "nullable": true
      }
    },
    "required": [
      "outcome",
      "tombstoned",
      "reconciliation_required",
      "message"
    ]
  },
  "SendIntentLookup": {
    "type": "object",
    "properties": {
      "found": {
        "type": "boolean"
      },
      "tombstoned": {
        "type": "boolean"
      },
      "reconciliation_required": {
        "type": "boolean"
      },
      "message": {
        "$ref": "#/components/schemas/SendIntentMessage",
        "nullable": true
      }
    },
    "required": [
      "found",
      "tombstoned",
      "reconciliation_required",
      "message"
    ]
  },
  "SendIntentMessage": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "id": {
        "type": "string"
      },
      "send_state": {
        "type": "string",
        "enum": [
          "none",
          "pending",
          "blocked",
          "cancelled",
          "sending",
          "sent",
          "failed",
          "uncertain"
        ]
      }
    },
    "required": [
      "id",
      "send_state"
    ]
  },
  "SendKey": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "owner_id": {
        "type": "string",
        "nullable": true
      },
      "prefix": {
        "type": "string",
        "nullable": true
      },
      "label": {
        "type": "string",
        "nullable": true
      },
      "last_used_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "revoked_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      },
      "updated_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "id",
      "owner_id",
      "prefix",
      "label",
      "last_used_at",
      "revoked_at",
      "created_at",
      "updated_at"
    ]
  },
  "SendMessageError": {
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "error": {
        "type": "string"
      },
      "reason": {
        "type": "string",
        "description": "Machine-readable failure class, e.g. provider_rejected | provider_outcome_uncertain | a policy code"
      },
      "provider_error": {
        "type": "string",
        "description": "The provider SDK error name (e.g. MessageRejected) when the provider call failed"
      },
      "sent": {
        "type": "boolean",
        "nullable": true,
        "description": "What is KNOWN about the send: false = definitively not sent (provider rejected); null = indeterminate (reconcile before retrying)"
      },
      "retry_safe": {
        "type": "boolean"
      },
      "reconciliation_required": {
        "type": "boolean"
      },
      "tombstoned": {
        "type": "boolean"
      },
      "message": {
        "oneOf": [
          {
            "$ref": "#/components/schemas/Message"
          },
          {
            "$ref": "#/components/schemas/SendIntentMessage"
          }
        ],
        "nullable": true
      }
    },
    "required": [
      "error",
      "retry_safe"
    ]
  },
  "Tenant": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "slug": {
        "type": "string"
      },
      "name": {
        "type": "string"
      },
      "status": {
        "type": "string"
      }
    },
    "required": [
      "id",
      "slug",
      "name",
      "status"
    ]
  },
  "TenantChoice": {
    "type": "object",
    "properties": {
      "slug": {
        "type": "string"
      },
      "name": {
        "type": "string"
      },
      "role": {
        "type": "string",
        "enum": [
          "owner",
          "admin",
          "member",
          "viewer"
        ]
      }
    },
    "required": [
      "slug",
      "name",
      "role"
    ]
  },
  "TenantMembershipSummary": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "slug": {
        "type": "string"
      },
      "name": {
        "type": "string"
      },
      "status": {
        "type": "string"
      },
      "role": {
        "type": "string",
        "enum": [
          "owner",
          "admin",
          "member",
          "viewer"
        ]
      }
    },
    "required": [
      "id",
      "slug",
      "name",
      "status",
      "role"
    ]
  },
  "Thread": {
    "type": "object",
    "properties": {
      "thread_key": {
        "type": "string",
        "description": "Normalized (Re:/Fwd:-stripped) subject key"
      },
      "subject": {
        "type": "string",
        "nullable": true
      },
      "message_count": {
        "type": "integer"
      },
      "unread_count": {
        "type": "integer"
      },
      "last_message_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "first_message_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "participants": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    },
    "required": [
      "thread_key",
      "subject",
      "message_count",
      "unread_count",
      "last_message_at",
      "first_message_at",
      "participants"
    ]
  },
  "User": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "email": {
        "type": "string",
        "format": "email"
      },
      "name": {
        "type": "string",
        "nullable": true
      },
      "status": {
        "type": "string"
      },
      "email_verified": {
        "type": "boolean"
      },
      "global_role": {
        "type": "string",
        "enum": [
          "user",
          "super_admin"
        ]
      },
      "is_primary_super_admin": {
        "type": "boolean"
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "id",
      "email",
      "name",
      "status",
      "email_verified",
      "global_role",
      "is_primary_super_admin",
      "created_at"
    ]
  },
  "WebhookReceipt": {
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "ok": {
        "type": "boolean"
      },
      "duplicate": {
        "type": "boolean",
        "description": "The event id was already completed in every destination scope"
      },
      "confirmed": {
        "type": "boolean",
        "description": "An SNS subscription confirmation was fetched"
      },
      "ignored": {
        "type": "string",
        "description": "Accepted but not persisted, with the reason"
      },
      "synced": {
        "type": "integer",
        "minimum": 0,
        "description": "Inbound objects newly stored"
      },
      "id": {
        "type": "string",
        "nullable": true,
        "description": "Stored inbound message id"
      },
      "event_id": {
        "type": "string",
        "description": "Stored delivery-outcome row id"
      },
      "type": {
        "type": "string",
        "description": "delivered | bounced | complained | opened | clicked"
      },
      "message_id": {
        "type": "string",
        "nullable": true,
        "description": "Provider message id"
      },
      "object_key": {
        "type": "string",
        "nullable": true,
        "description": "S3 object key the notification referenced"
      }
    },
    "required": [
      "ok"
    ]
  }
};
