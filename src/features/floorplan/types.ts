export type TableShape = "circular" | "rectangular";

export interface ChairItem {
  id: string; // `${tableId}:${seatIndex}`
  seatIndex: number; // 1-based, drives the geometry
  claimedByName: string | null;
  isMine: boolean;
  isPending: boolean; // claim or release not yet confirmed by the server
}

export interface TableItem {
  id: string; // client-generated UUID
  name: string;
  type: TableShape;
  seats: number;
  x: number; // always the top-left of the bounding box, even for circles
  y: number;
  radius?: number;
  width?: number;
  height?: number;
  isPending: boolean;
  chairs: ChairItem[];
}

export interface BoundsRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoundsWithId extends BoundsRect {
  id: string;
}

export type AlignKind = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export type SizeKind = "width" | "height";
export type AxisKind = "horizontal" | "vertical";
