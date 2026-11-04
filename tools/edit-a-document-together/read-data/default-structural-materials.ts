// File: documents/read-data/default-structural-materials.ts
//
// The built-in insert catalog as frozen DATA — pure MaterialDescriptor records whose
// `node` is a STATIC template (stable `node:tplN` ids). materialNode() → freshIds()
// re-mints every id on insert, so these are templates, never live instance ids (#27).
//
// GROUPS (B1 — the full rich block catalog as DATA; the generic renderer stays blind):
//   • Layout       — Columns, Table, Panels (split/flex layout templates)
//   • Basic blocks — Text, Heading 1-4, Toggle heading 1-3, Quote, Callout, Divider, Code
//   • Lists        — Bulleted, Numbered, To-do, Toggle  (interactive To-do / Toggle carry
//                    an inline `fsm` + `$selfFsm` visibility bindings; the surface's
//                    interactive-block primitive re-owns them per instance via freshIds()).
//
// Why a frozen DATA MODULE (the cold-client gate): built-in blocks must be UNCONDITIONALLY
// available — a cold client whose live slot read fails (status=3) must STILL get the
// catalog. The capable default SEED ships as package DATA (L083), OUTSIDE the surface
// consumer (enum-dissolution: the consumer never branches on a block id — it clones `node`
// like any descriptor). User EXTENSION is additive: live material rows
// (readMaterialDescriptors) + authored components merge into the SAME materials list.
//
// Hand-authored DATA — the June-22 gen-structural-materials.mjs generator is retired; THIS
// committed module is the source of truth. Add a block = add ONE MaterialDescriptor row
// here; ZERO renderer code changes (B1 / L090 / enum-dissolution).
import type { MaterialDescriptor } from './documents';

export const DEFAULT_STRUCTURAL_MATERIALS: MaterialDescriptor[] = [
  {
    "id": "structure:columns",
    "label": "Columns",
    "icon": "Columns2",
    "group": "Layout",
    "match_terms": [
      "columns",
      "column",
      "split",
      "two column",
      "side by side",
      "layout"
    ],
    "node": {
      "id": "node:tpl5",
      "kind": "Container",
      "props": {
        "style": {
          "layout": {
            "mode": "split",
            "axis": "x",
            "gap": 12,
            "parts": [
              {
                "fraction": 1
              },
              {
                "fraction": 1
              }
            ]
          }
        }
      },
      "visible": true,
      "children": [
        {
          "id": "node:tpl1",
          "kind": "Container",
          "props": {},
          "visible": true,
          "children": [
            {
              "id": "node:tpl2",
              "kind": "Text",
              "props": {
                "text": ""
              },
              "visible": true,
              "children": []
            }
          ]
        },
        {
          "id": "node:tpl3",
          "kind": "Container",
          "props": {},
          "visible": true,
          "children": [
            {
              "id": "node:tpl4",
              "kind": "Text",
              "props": {
                "text": ""
              },
              "visible": true,
              "children": []
            }
          ]
        }
      ]
    }
  },
  {
    "id": "structure:table",
    "label": "Table",
    "icon": "Table",
    "group": "Layout",
    "match_terms": [
      "table",
      "grid",
      "rows",
      "cells",
      "spreadsheet",
      "matrix"
    ],
    "node": {
      "id": "node:tpl6",
      "kind": "Container",
      "props": {
        "style": {
          "layout": {
            "mode": "split",
            "axis": "y",
            "gap": 1,
            "parts": [
              {
                "fraction": 1
              },
              {
                "fraction": 1
              },
              {
                "fraction": 1
              }
            ]
          }
        }
      },
      "visible": true,
      "children": [
        {
          "id": "node:tpl7",
          "kind": "Container",
          "props": {
            "style": {
              "layout": {
                "mode": "split",
                "axis": "x",
                "gap": 1,
                "parts": [
                  {
                    "fraction": 1
                  },
                  {
                    "fraction": 1
                  },
                  {
                    "fraction": 1
                  }
                ]
              }
            }
          },
          "visible": true,
          "children": [
            {
              "id": "node:tpl8",
              "kind": "Container",
              "props": {},
              "visible": true,
              "children": [
                {
                  "id": "node:tpl9",
                  "kind": "Text",
                  "props": {
                    "text": ""
                  },
                  "visible": true,
                  "children": []
                }
              ]
            },
            {
              "id": "node:tpl10",
              "kind": "Container",
              "props": {},
              "visible": true,
              "children": [
                {
                  "id": "node:tpl11",
                  "kind": "Text",
                  "props": {
                    "text": ""
                  },
                  "visible": true,
                  "children": []
                }
              ]
            },
            {
              "id": "node:tpl12",
              "kind": "Container",
              "props": {},
              "visible": true,
              "children": [
                {
                  "id": "node:tpl13",
                  "kind": "Text",
                  "props": {
                    "text": ""
                  },
                  "visible": true,
                  "children": []
                }
              ]
            }
          ]
        },
        {
          "id": "node:tpl14",
          "kind": "Container",
          "props": {
            "style": {
              "layout": {
                "mode": "split",
                "axis": "x",
                "gap": 1,
                "parts": [
                  {
                    "fraction": 1
                  },
                  {
                    "fraction": 1
                  },
                  {
                    "fraction": 1
                  }
                ]
              }
            }
          },
          "visible": true,
          "children": [
            {
              "id": "node:tpl15",
              "kind": "Container",
              "props": {},
              "visible": true,
              "children": [
                {
                  "id": "node:tpl16",
                  "kind": "Text",
                  "props": {
                    "text": ""
                  },
                  "visible": true,
                  "children": []
                }
              ]
            },
            {
              "id": "node:tpl17",
              "kind": "Container",
              "props": {},
              "visible": true,
              "children": [
                {
                  "id": "node:tpl18",
                  "kind": "Text",
                  "props": {
                    "text": ""
                  },
                  "visible": true,
                  "children": []
                }
              ]
            },
            {
              "id": "node:tpl19",
              "kind": "Container",
              "props": {},
              "visible": true,
              "children": [
                {
                  "id": "node:tpl20",
                  "kind": "Text",
                  "props": {
                    "text": ""
                  },
                  "visible": true,
                  "children": []
                }
              ]
            }
          ]
        },
        {
          "id": "node:tpl21",
          "kind": "Container",
          "props": {
            "style": {
              "layout": {
                "mode": "split",
                "axis": "x",
                "gap": 1,
                "parts": [
                  {
                    "fraction": 1
                  },
                  {
                    "fraction": 1
                  },
                  {
                    "fraction": 1
                  }
                ]
              }
            }
          },
          "visible": true,
          "children": [
            {
              "id": "node:tpl22",
              "kind": "Container",
              "props": {},
              "visible": true,
              "children": [
                {
                  "id": "node:tpl23",
                  "kind": "Text",
                  "props": {
                    "text": ""
                  },
                  "visible": true,
                  "children": []
                }
              ]
            },
            {
              "id": "node:tpl24",
              "kind": "Container",
              "props": {},
              "visible": true,
              "children": [
                {
                  "id": "node:tpl25",
                  "kind": "Text",
                  "props": {
                    "text": ""
                  },
                  "visible": true,
                  "children": []
                }
              ]
            },
            {
              "id": "node:tpl26",
              "kind": "Container",
              "props": {},
              "visible": true,
              "children": [
                {
                  "id": "node:tpl27",
                  "kind": "Text",
                  "props": {
                    "text": ""
                  },
                  "visible": true,
                  "children": []
                }
              ]
            }
          ]
        }
      ]
    }
  },
  {
    "id": "structure:panels",
    "label": "Panels",
    "icon": "PanelsTopLeft",
    "group": "Layout",
    "match_terms": [
      "panels",
      "panel",
      "command center",
      "dashboard",
      "split view",
      "workspace",
      "collapse"
    ],
    "node": {
      "id": "node:tpl32",
      "kind": "Container",
      "props": {
        "style": {
          "layout": {
            "mode": "flex",
            "axis": "x",
            "gap": 12
          }
        }
      },
      "visible": true,
      "children": [
        {
          "id": "node:tpl28",
          "kind": "Container",
          "props": {
            "style": {
              "flex": 1
            }
          },
          "visible": true,
          "children": [
            {
              "id": "node:tpl29",
              "kind": "Text",
              "props": {
                "text": ""
              },
              "visible": true,
              "children": []
            }
          ]
        },
        {
          "id": "node:tpl30",
          "kind": "Container",
          "props": {
            "style": {
              "flex": 1
            }
          },
          "visible": true,
          "children": [
            {
              "id": "node:tpl31",
              "kind": "Text",
              "props": {
                "text": ""
              },
              "visible": true,
              "children": []
            }
          ]
        }
      ]
    }
  },
  {
    "id": "block:text",
    "label": "Text",
    "icon": "Type",
    "group": "Basic blocks",
    "match_terms": [
      "text",
      "paragraph",
      "plain",
      "body",
      "write"
    ],
    "node": {
      "id": "node:tpl33",
      "kind": "Text",
      "props": {
        "text": "",
        "content_role": "primary"
      },
      "visible": true,
      "children": []
    }
  },
  {
    "id": "block:h1",
    "label": "Heading 1",
    "icon": "Heading1",
    "group": "Basic blocks",
    "match_terms": [
      "heading",
      "h1",
      "title",
      "header",
      "big"
    ],
    "node": {
      "id": "node:tpl34",
      "kind": "Text",
      "props": {
        "text": "",
        "content_role": "primary",
        "style": {
          "font_size": 30,
          "font_weight": 700
        },
        "placeholder": "Heading 1"
      },
      "visible": true,
      "children": []
    }
  },
  {
    "id": "block:h2",
    "label": "Heading 2",
    "icon": "Heading2",
    "group": "Basic blocks",
    "match_terms": [
      "heading",
      "h2",
      "subtitle",
      "header",
      "medium"
    ],
    "node": {
      "id": "node:tpl35",
      "kind": "Text",
      "props": {
        "text": "",
        "content_role": "primary",
        "style": {
          "font_size": 22,
          "font_weight": 600
        },
        "placeholder": "Heading 2"
      },
      "visible": true,
      "children": []
    }
  },
  {
    "id": "block:h3",
    "label": "Heading 3",
    "icon": "Heading3",
    "group": "Basic blocks",
    "match_terms": [
      "heading",
      "h3",
      "subheader",
      "small heading"
    ],
    "node": {
      "id": "node:tpl36",
      "kind": "Text",
      "props": {
        "text": "",
        "content_role": "primary",
        "style": {
          "font_size": 18,
          "font_weight": 600
        },
        "placeholder": "Heading 3"
      },
      "visible": true,
      "children": []
    }
  },
  {
    "id": "block:h4",
    "label": "Heading 4",
    "icon": "Heading4",
    "group": "Basic blocks",
    "match_terms": [
      "heading",
      "h4",
      "minor heading",
      "sub-subheading",
      "tiny heading"
    ],
    "node": {
      "id": "node:tpl37",
      "kind": "Text",
      "props": {
        "text": "",
        "content_role": "primary",
        "style": {
          "font_size": 16,
          "font_weight": 600
        },
        "placeholder": "Heading 4"
      },
      "visible": true,
      "children": []
    }
  },
  {
    "id": "block:toggle-h1",
    "label": "Toggle heading 1",
    "icon": "ChevronRight",
    "group": "Basic blocks",
    "match_terms": [
      "toggle heading",
      "collapsible heading",
      "toggle h1",
      "foldable title",
      "collapsible section"
    ],
    "node": {
      "id": "node:tpl38",
      "kind": "Container",
      "props": {
        "interaction": {"role": "button", "label": "Toggle contents", "active_state": "open", "icon": "ChevronRight", "active_icon": "ChevronDown", "structure": {"primary_role": "primary", "body_role": "body", "enter_placement": "body", "enter_state": "open", "continue_material_id": "block:toggle-h1", "continue_state": "open", "nestable": true}},
        "style": {
          "layout": {
            "mode": "flex",
            "axis": "y",
            "gap": 4
          }
        },
        "handlers": {
          "click": [
            {
              "kind": "DISPATCH_FSM",
              "event": {
                "type": "toggle"
              }
            }
          ]
        }
      },
      "fsm": {
        "initial": "open",
        "states": {
          "open": {
            "on": {
              "toggle": [
                {
                  "target": "closed"
                }
              ]
            }
          },
          "closed": {
            "on": {
              "toggle": [
                {
                  "target": "open"
                }
              ]
            }
          }
        }
      },
      "visible": true,
      "children": [
        {
          "id": "node:tpl39",
          "kind": "Container",
          "synthetic": true,
          "props": {
            "style": {
              "layout": {
                "mode": "flex",
                "axis": "x",
                "gap": 6
              }
            }
          },
          "visible": true,
          "children": [
            {
              "id": "node:tpl40",
              "kind": "Text",
              "synthetic": true,
              "props": {
                "text": "▾"
              },
              "visible": {
                "$kind": "binding",
                "select": {
                  "from": "fsm",
                  "path": "$selfFsm"
                },
                "transform": [
                  {
                    "op": "op:core.equals",
                    "args": {
                      "value": "open"
                    }
                  }
                ],
                "default": true
              },
              "children": []
            },
            {
              "id": "node:tpl41",
              "kind": "Text",
              "synthetic": true,
              "props": {
                "text": "▸"
              },
              "visible": {
                "$kind": "binding",
                "select": {
                  "from": "fsm",
                  "path": "$selfFsm"
                },
                "transform": [
                  {
                    "op": "op:core.equals",
                    "args": {
                      "value": "closed"
                    }
                  }
                ],
                "default": false
              },
              "children": []
            },
            {
              "id": "node:tpl42",
              "kind": "Text",
              "props": {
                "text": "",
                "content_role": "primary",
                "placeholder": "Toggle heading 1",
                "custom": {"heading_level": 1},
                "style": {
                  "font_size": 30,
                  "font_weight": 700
                }
              },
              "visible": true,
              "children": []
            }
          ]
        },
        {
          "id": "node:tpl43",
          "kind": "Container",
          "props": {
            "style": {
              "padding": {
                "left": 48
              }
            }
          },
          "visible": {
            "$kind": "binding",
            "select": {
              "from": "fsm",
              "path": "$selfFsm"
            },
            "transform": [
              {
                "op": "op:core.equals",
                "args": {
                  "value": "open"
                }
              }
            ],
            "default": true
          },
          "children": [
            {
              "id": "node:tpl44",
              "kind": "Text",
              "props": {
                "text": "",
                "content_role": "body",
                "placeholder": "Toggle contents"
              },
              "visible": true,
              "children": []
            }
          ]
        }
      ]
    }
  },
  {
    "id": "block:toggle-h2",
    "label": "Toggle heading 2",
    "icon": "ChevronRight",
    "group": "Basic blocks",
    "match_terms": [
      "toggle heading",
      "collapsible heading",
      "toggle h2",
      "collapsible subheading"
    ],
    "node": {
      "id": "node:tpl45",
      "kind": "Container",
      "props": {
        "interaction": {"role": "button", "label": "Toggle contents", "active_state": "open", "icon": "ChevronRight", "active_icon": "ChevronDown", "structure": {"primary_role": "primary", "body_role": "body", "enter_placement": "body", "enter_state": "open", "continue_material_id": "block:toggle-h2", "continue_state": "open", "nestable": true}},
        "style": {
          "layout": {
            "mode": "flex",
            "axis": "y",
            "gap": 4
          }
        },
        "handlers": {
          "click": [
            {
              "kind": "DISPATCH_FSM",
              "event": {
                "type": "toggle"
              }
            }
          ]
        }
      },
      "fsm": {
        "initial": "open",
        "states": {
          "open": {
            "on": {
              "toggle": [
                {
                  "target": "closed"
                }
              ]
            }
          },
          "closed": {
            "on": {
              "toggle": [
                {
                  "target": "open"
                }
              ]
            }
          }
        }
      },
      "visible": true,
      "children": [
        {
          "id": "node:tpl46",
          "kind": "Container",
          "synthetic": true,
          "props": {
            "style": {
              "layout": {
                "mode": "flex",
                "axis": "x",
                "gap": 6
              }
            }
          },
          "visible": true,
          "children": [
            {
              "id": "node:tpl47",
              "kind": "Text",
              "synthetic": true,
              "props": {
                "text": "▾"
              },
              "visible": {
                "$kind": "binding",
                "select": {
                  "from": "fsm",
                  "path": "$selfFsm"
                },
                "transform": [
                  {
                    "op": "op:core.equals",
                    "args": {
                      "value": "open"
                    }
                  }
                ],
                "default": true
              },
              "children": []
            },
            {
              "id": "node:tpl48",
              "kind": "Text",
              "synthetic": true,
              "props": {
                "text": "▸"
              },
              "visible": {
                "$kind": "binding",
                "select": {
                  "from": "fsm",
                  "path": "$selfFsm"
                },
                "transform": [
                  {
                    "op": "op:core.equals",
                    "args": {
                      "value": "closed"
                    }
                  }
                ],
                "default": false
              },
              "children": []
            },
            {
              "id": "node:tpl49",
              "kind": "Text",
              "props": {
                "text": "",
                "content_role": "primary",
                "placeholder": "Toggle heading 2",
                "custom": {"heading_level": 2},
                "style": {
                  "font_size": 22,
                  "font_weight": 600
                }
              },
              "visible": true,
              "children": []
            }
          ]
        },
        {
          "id": "node:tpl50",
          "kind": "Container",
          "props": {
            "style": {
              "padding": {
                "left": 48
              }
            }
          },
          "visible": {
            "$kind": "binding",
            "select": {
              "from": "fsm",
              "path": "$selfFsm"
            },
            "transform": [
              {
                "op": "op:core.equals",
                "args": {
                  "value": "open"
                }
              }
            ],
            "default": true
          },
          "children": [
            {
              "id": "node:tpl51",
              "kind": "Text",
              "props": {
                "text": "",
                "content_role": "body",
                "placeholder": "Toggle contents"
              },
              "visible": true,
              "children": []
            }
          ]
        }
      ]
    }
  },
  {
    "id": "block:toggle-h3",
    "label": "Toggle heading 3",
    "icon": "ChevronRight",
    "group": "Basic blocks",
    "match_terms": [
      "toggle heading",
      "collapsible heading",
      "toggle h3"
    ],
    "node": {
      "id": "node:tpl52",
      "kind": "Container",
      "props": {
        "interaction": {"role": "button", "label": "Toggle contents", "active_state": "open", "icon": "ChevronRight", "active_icon": "ChevronDown", "structure": {"primary_role": "primary", "body_role": "body", "enter_placement": "body", "enter_state": "open", "continue_material_id": "block:toggle-h3", "continue_state": "open", "nestable": true}},
        "style": {
          "layout": {
            "mode": "flex",
            "axis": "y",
            "gap": 4
          }
        },
        "handlers": {
          "click": [
            {
              "kind": "DISPATCH_FSM",
              "event": {
                "type": "toggle"
              }
            }
          ]
        }
      },
      "fsm": {
        "initial": "open",
        "states": {
          "open": {
            "on": {
              "toggle": [
                {
                  "target": "closed"
                }
              ]
            }
          },
          "closed": {
            "on": {
              "toggle": [
                {
                  "target": "open"
                }
              ]
            }
          }
        }
      },
      "visible": true,
      "children": [
        {
          "id": "node:tpl53",
          "kind": "Container",
          "synthetic": true,
          "props": {
            "style": {
              "layout": {
                "mode": "flex",
                "axis": "x",
                "gap": 6
              }
            }
          },
          "visible": true,
          "children": [
            {
              "id": "node:tpl54",
              "kind": "Text",
              "synthetic": true,
              "props": {
                "text": "▾"
              },
              "visible": {
                "$kind": "binding",
                "select": {
                  "from": "fsm",
                  "path": "$selfFsm"
                },
                "transform": [
                  {
                    "op": "op:core.equals",
                    "args": {
                      "value": "open"
                    }
                  }
                ],
                "default": true
              },
              "children": []
            },
            {
              "id": "node:tpl55",
              "kind": "Text",
              "synthetic": true,
              "props": {
                "text": "▸"
              },
              "visible": {
                "$kind": "binding",
                "select": {
                  "from": "fsm",
                  "path": "$selfFsm"
                },
                "transform": [
                  {
                    "op": "op:core.equals",
                    "args": {
                      "value": "closed"
                    }
                  }
                ],
                "default": false
              },
              "children": []
            },
            {
              "id": "node:tpl56",
              "kind": "Text",
              "props": {
                "text": "",
                "content_role": "primary",
                "placeholder": "Toggle heading 3",
                "custom": {"heading_level": 3},
                "style": {
                  "font_size": 18,
                  "font_weight": 600
                }
              },
              "visible": true,
              "children": []
            }
          ]
        },
        {
          "id": "node:tpl57",
          "kind": "Container",
          "props": {
            "style": {
              "padding": {
                "left": 48
              }
            }
          },
          "visible": {
            "$kind": "binding",
            "select": {
              "from": "fsm",
              "path": "$selfFsm"
            },
            "transform": [
              {
                "op": "op:core.equals",
                "args": {
                  "value": "open"
                }
              }
            ],
            "default": true
          },
          "children": [
            {
              "id": "node:tpl58",
              "kind": "Text",
              "props": {
                "text": "",
                "content_role": "body",
                "placeholder": "Toggle contents"
              },
              "visible": true,
              "children": []
            }
          ]
        }
      ]
    }
  },
  {
    "id": "block:quote",
    "label": "Quote",
    "icon": "Quote",
    "group": "Basic blocks",
    "match_terms": [
      "quote",
      "blockquote",
      "cite"
    ],
    "node": {
      "id": "node:tpl59",
      "kind": "Text",
      "props": {
        "text": "",
        "content_role": "primary",
        "style": {
          "font_style": "italic",
          "color": "rgba(235,235,240,0.72)",
          "padding": {
            "left": 14
          }
        },
        "placeholder": "Quote"
      },
      "visible": true,
      "children": []
    }
  },
  {
    "id": "block:callout",
    "label": "Callout",
    "icon": "Info",
    "group": "Basic blocks",
    "match_terms": [
      "callout",
      "note",
      "info",
      "tip",
      "highlight",
      "aside"
    ],
    "node": {
      "id": "node:tpl60",
      "kind": "Container",
      "props": {
        "style": {
          "background": "rgba(120,140,255,0.10)",
          "border_radius": 8,
          "padding": {
            "top": 12,
            "right": 14,
            "bottom": 12,
            "left": 14
          }
        }
      },
      "visible": true,
      "children": [
        {
          "id": "node:tpl61",
          "kind": "Text",
          "props": {
            "text": "",
            "content_role": "primary",
            "placeholder": "Write something…"
          },
          "visible": true,
          "children": []
        }
      ]
    }
  },
  {
    "id": "block:divider",
    "label": "Divider",
    "icon": "Minus",
    "group": "Basic blocks",
    "match_terms": [
      "divider",
      "separator",
      "line",
      "rule",
      "hr",
      "break"
    ],
    "node": {
      "id": "node:tpl62",
      "kind": "Container",
      "props": {
        "style": {
          "background": "rgba(255,255,255,0.14)",
          "border_radius": 2,
          "padding": {
            "top": 1,
            "bottom": 1
          }
        }
      },
      "visible": true,
      "children": []
    }
  },
  {
    "id": "block:code",
    "label": "Code",
    "icon": "Code2",
    "group": "Basic blocks",
    "match_terms": [
      "code",
      "snippet",
      "monospace",
      "pre",
      "terminal",
      "syntax"
    ],
    "node": {
      "id": "node:tpl63",
      "kind": "Text",
      "props": {
        "text": "",
        "made_by_shortcut": "shortcut:code-fence",
        "custom": {
          "interchange_kind": "fenced-code"
        },
        "content_role": "primary",
        "placeholder": "Code",
        "look": "code"
      },
      "visible": true,
      "children": []
    }
  },
  {
    "id": "block:bulleted",
    "label": "Bulleted list",
    "icon": "List",
    "group": "Lists",
    "match_terms": [
      "bulleted",
      "bullet",
      "unordered",
      "list",
      "ul",
      "dot"
    ],
    "node": {
      "id": "node:tpl65",
      "kind": "Container",
      "props": {
        "style": {
          "layout": {
            "mode": "flex",
            "axis": "x",
            "gap": 8
          }
        }
      },
      "visible": true,
      "children": [
        {
          "id": "node:tpl66",
          "kind": "Text",
          "props": {
            "text": "•"
          },
          "visible": true,
          "children": []
        },
        {
          "id": "node:tpl67",
          "kind": "Text",
          "props": {
            "text": "",
            "content_role": "primary",
            "placeholder": "List"
          },
          "visible": true,
          "children": []
        }
      ]
    }
  },
  {
    "id": "block:numbered",
    "label": "Numbered list",
    "icon": "ListOrdered",
    "group": "Lists",
    "match_terms": [
      "numbered",
      "ordered",
      "list",
      "ol",
      "number"
    ],
    "node": {
      "id": "node:tpl68",
      "kind": "Container",
      "props": {
        "style": {
          "layout": {
            "mode": "flex",
            "axis": "x",
            "gap": 8
          }
        }
      },
      "visible": true,
      "children": [
        {
          "id": "node:tpl69",
          "kind": "Text",
          "props": {
            "text": "1."
          },
          "visible": true,
          "children": []
        },
        {
          "id": "node:tpl70",
          "kind": "Text",
          "props": {
            "text": "",
            "content_role": "primary",
            "placeholder": "List"
          },
          "visible": true,
          "children": []
        }
      ]
    }
  },
  {
    "id": "block:todo",
    "label": "To-do list",
    "icon": "CheckSquare",
    "group": "Lists",
    "match_terms": [
      "todo",
      "to-do",
      "to do",
      "task",
      "checkbox",
      "check",
      "checklist",
      "done",
      "tick"
    ],
    "node": {
      "id": "node:tpl71",
      "kind": "Container",
      "props": {
        "style": {
          "layout": {
            "mode": "flex",
            "axis": "y",
            "gap": 0
          }
        },
        "interaction": {
          "structure": {
            "primary_role": "primary",
            "body_role": "body",
            "enter_placement": "sibling",
            "continue_material_id": "block:todo",
            "nestable": true,
            "list_item": true
          }
        }
      },
      "visible": true,
      "children": [
        {
          "id": "node:tpl71-row",
          "kind": "Container",
          "props": {
            "style": {
              "layout": {
                "mode": "flex",
                "axis": "x",
                "gap": 8
              }
            }
          },
          "visible": true,
          "children": [
            {
              "id": "node:tpl72",
              "kind": "Container",
              "fsm": {
                "initial": "unchecked",
                "states": {
                  "unchecked": {
                    "on": {
                      "toggle": [
                        {
                          "target": "checked"
                        }
                      ]
                    }
                  },
                  "checked": {
                    "on": {
                      "toggle": [
                        {
                          "target": "unchecked"
                        }
                      ]
                    }
                  }
                }
              },
              "props": {
                "interaction": {
                  "role": "checkbox",
                  "label": "Check item",
                  "active_state": "checked",
                  "icon": "Square",
                  "active_icon": "SquareCheck"
                },
                "handlers": {
                  "click": [
                    {
                      "kind": "DISPATCH_FSM",
                      "event": {
                        "type": "toggle"
                      }
                    }
                  ]
                },
                "style": {
                  "width": 24,
                  "layout": {
                    "mode": "flex",
                    "axis": "x"
                  }
                }
              },
              "visible": true,
              "children": [
                {
                  "id": "node:tpl73",
                  "kind": "Text",
                  "synthetic": true,
                  "props": {
                    "text": "☐"
                  },
                  "visible": {
                    "$kind": "binding",
                    "select": {
                      "from": "fsm",
                      "path": "$selfFsm"
                    },
                    "transform": [
                      {
                        "op": "op:core.equals",
                        "args": {
                          "value": "unchecked"
                        }
                      }
                    ],
                    "default": true
                  },
                  "children": []
                },
                {
                  "id": "node:tpl74",
                  "kind": "Text",
                  "synthetic": true,
                  "props": {
                    "text": "☑",
                    "style": {
                      "color": "rgba(120,170,255,0.95)"
                    }
                  },
                  "visible": {
                    "$kind": "binding",
                    "select": {
                      "from": "fsm",
                      "path": "$selfFsm"
                    },
                    "transform": [
                      {
                        "op": "op:core.equals",
                        "args": {
                          "value": "checked"
                        }
                      }
                    ],
                    "default": false
                  },
                  "children": []
                }
              ]
            },
            {
              "id": "node:tpl75",
              "kind": "Text",
              "props": {
                "text": "",
                "content_role": "primary",
                "placeholder": "To-do"
              },
              "visible": true,
              "children": []
            }
          ]
        },
        {
          "id": "node:tpl71-body",
          "kind": "Container",
          "props": {
            "content_role": "body",
            "style": {
              "padding": {
                "left": 32
              },
              "layout": {
                "mode": "flex",
                "axis": "y",
                "gap": 0
              }
            }
          },
          "visible": true,
          "children": []
        }
      ]
    }
  },
  {
    "id": "block:toggle",
    "label": "Toggle list",
    "icon": "ChevronRight",
    "group": "Lists",
    "match_terms": [
      "toggle",
      "collapse",
      "expand",
      "accordion",
      "disclosure",
      "fold",
      "details",
      "dropdown",
      "show hide"
    ],
    "node": {
      "id": "node:tpl76",
      "kind": "Container",
      "props": {
        "interaction": {"role": "button", "label": "Toggle contents", "active_state": "open", "icon": "ChevronRight", "active_icon": "ChevronDown", "structure": {"primary_role": "primary", "body_role": "body", "enter_placement": "body", "enter_state": "open", "continue_material_id": "block:toggle", "continue_state": "open", "nestable": true}},
        "style": {
          "layout": {
            "mode": "flex",
            "axis": "y",
            "gap": 4
          }
        },
        "handlers": {
          "click": [
            {
              "kind": "DISPATCH_FSM",
              "event": {
                "type": "toggle"
              }
            }
          ]
        }
      },
      "fsm": {
        "initial": "open",
        "states": {
          "open": {
            "on": {
              "toggle": [
                {
                  "target": "closed"
                }
              ]
            }
          },
          "closed": {
            "on": {
              "toggle": [
                {
                  "target": "open"
                }
              ]
            }
          }
        }
      },
      "visible": true,
      "children": [
        {
          "id": "node:tpl77",
          "kind": "Container",
          "synthetic": true,
          "props": {
            "style": {
              "layout": {
                "mode": "flex",
                "axis": "x",
                "gap": 6
              }
            }
          },
          "visible": true,
          "children": [
            {
              "id": "node:tpl78",
              "kind": "Text",
              "synthetic": true,
              "props": {
                "text": "▾"
              },
              "visible": {
                "$kind": "binding",
                "select": {
                  "from": "fsm",
                  "path": "$selfFsm"
                },
                "transform": [
                  {
                    "op": "op:core.equals",
                    "args": {
                      "value": "open"
                    }
                  }
                ],
                "default": true
              },
              "children": []
            },
            {
              "id": "node:tpl79",
              "kind": "Text",
              "synthetic": true,
              "props": {
                "text": "▸"
              },
              "visible": {
                "$kind": "binding",
                "select": {
                  "from": "fsm",
                  "path": "$selfFsm"
                },
                "transform": [
                  {
                    "op": "op:core.equals",
                    "args": {
                      "value": "closed"
                    }
                  }
                ],
                "default": false
              },
              "children": []
            },
            {
              "id": "node:tpl80",
              "kind": "Text",
              "props": {
                "text": "",
                "content_role": "primary",
                "placeholder": "Toggle"
              },
              "visible": true,
              "children": []
            }
          ]
        },
        {
          "id": "node:tpl81",
          "kind": "Container",
          "props": {
            "style": {
              "padding": {
                "left": 48
              }
            }
          },
          "visible": {
            "$kind": "binding",
            "select": {
              "from": "fsm",
              "path": "$selfFsm"
            },
            "transform": [
              {
                "op": "op:core.equals",
                "args": {
                  "value": "open"
                }
              }
            ],
            "default": true
          },
          "children": [
            {
              "id": "node:tpl82",
              "kind": "Text",
              "props": {
                "text": "",
                "content_role": "body",
                "placeholder": "Toggle contents"
              },
              "visible": true,
              "children": []
            }
          ]
        }
      ]
    }
  },
];
