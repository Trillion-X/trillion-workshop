export type JsonObject = { readonly [key: string]: unknown };

export type InputRow = {
  readonly address?: string;
  readonly payload?: unknown;
  readonly record?: JsonObject;
  readonly [key: string]: unknown;
};

export type SelectorExpression = {
  readonly method: string;
  readonly params?: JsonObject;
};

export type EndpointDescriptor = {
  readonly role: string;
  readonly value: SelectorExpression;
};

export type AttributeDescriptor = {
  readonly name: string;
  readonly value: SelectorExpression;
};

export type RecordSelectorDescriptor = {
  readonly id?: string;
  readonly match?: SelectorExpression;
  readonly connection: {
    readonly identity: SelectorExpression;
    readonly endpoints: readonly EndpointDescriptor[];
    readonly attributes?: readonly AttributeDescriptor[];
  };
};

export type ViewDescriptor = {
  readonly id: string;
  readonly label: string;
  readonly filter?: SelectorExpression;
};

export type ActionDescriptor = {
  readonly id: string;
  readonly label?: string;
  readonly target?: string;
  readonly operation?: string;
  readonly definition_id?: string;
  readonly input_mapping?: Record<string, SelectorExpression>;
  readonly status_mapping?: JsonObject;
};

export type ConnectionProjectionDescriptor = {
  readonly kind: 'generic-connection-projection-descriptor';
  readonly id: string;
  readonly input_feeds?: readonly JsonObject[];
  readonly record_selectors: readonly RecordSelectorDescriptor[];
  readonly views?: readonly ViewDescriptor[];
  readonly actions?: readonly ActionDescriptor[];
};

export type ConnectionEndpoint = {
  readonly role: string;
  readonly node_id: string;
};

export type ConnectionNode = {
  readonly id: string;
  readonly attributes: JsonObject;
  readonly connection_ids: readonly string[];
};

export type ConnectionEdge = {
  readonly id: string;
  readonly endpoints: readonly ConnectionEndpoint[];
  readonly attributes: JsonObject;
  readonly source_row_address?: string;
};

export type ProjectionIssue = {
  readonly code: string;
  readonly selector_id?: string;
  readonly row_address?: string;
};

export type ConnectionGraphModel = {
  readonly descriptor_id: string;
  readonly nodes: readonly ConnectionNode[];
  readonly connections: readonly ConnectionEdge[];
  readonly views: readonly ViewDescriptor[];
  readonly actions: readonly ActionDescriptor[];
  readonly issues: readonly ProjectionIssue[];
  readonly changed: {
    readonly node_ids: readonly string[];
    readonly connection_ids: readonly string[];
  };
};
