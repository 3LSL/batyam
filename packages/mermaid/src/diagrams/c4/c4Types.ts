/** A text element of a C4 entity (label, type, technology, description). */
export interface C4Text {
  text: string;
}

export interface C4Shape {
  /** The parser may set additional keys via `{ key: value }` shaped arguments. */
  [key: string]: unknown;
  alias: string;
  label: C4Text;
  typeC4Shape: C4Text;
  parentBoundary: string;
  wrap?: boolean;
  descr?: C4Text;
  techn?: C4Text;
  type?: C4Text;
  sprite?: string;
  tags?: string;
  link?: string;
  /* Style fields, set via UpdateElementStyle. */
  bgColor?: string;
  fontColor?: string;
  borderColor?: string;
  shadowing?: string;
  shape?: string;
  legendText?: string;
  legendSprite?: string;
}

export interface C4Boundary {
  /** The parser may set additional keys via `{ key: value }` shaped arguments. */
  [key: string]: unknown;
  alias: string;
  label: C4Text;
  type: C4Text;
  tags?: string | null;
  link?: string | null;
  parentBoundary: string;
  wrap?: boolean;
  descr?: C4Text;
  techn?: C4Text;
  /** Set for a deployment node: `node`, `nodeL` or `nodeR`. */
  nodeType?: string;
  sprite?: string;
  /* Style fields, set via UpdateElementStyle. */
  bgColor?: string;
  fontColor?: string;
  borderColor?: string;
  shadowing?: string;
  shape?: string;
  legendText?: string;
  legendSprite?: string;
}

export interface C4Rel {
  /** The parser may set additional keys via `{ key: value }` shaped arguments. */
  [key: string]: unknown;
  type: string;
  from: string;
  to: string;
  label: C4Text;
  techn: C4Text;
  descr: C4Text;
  sprite?: string;
  tags?: string;
  link?: string;
  wrap?: boolean;
  /* Style fields, set via UpdateRelStyle. */
  textColor?: string;
  lineColor?: string;
  offsetX?: number;
  offsetY?: number;
}
