// Minimal typing for the parts of jsdom used by html.ts (@types/jsdom is not installed;
// the server's tsconfig has no DOM lib, so nodes are typed structurally).
declare module "jsdom" {
  export interface MiniNode {
    nodeType: number;
    nodeName: string;
    textContent: string | null;
    childNodes: ArrayLike<MiniNode>;
  }
  export interface MiniElement extends MiniNode {
    tagName: string;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    remove(): void;
    querySelectorAll(sel: string): ArrayLike<MiniElement>;
  }
  export interface MiniDocument {
    body: MiniElement | null;
    querySelectorAll(sel: string): ArrayLike<MiniElement>;
  }
  export interface MiniStyle {
    display: string;
    visibility: string;
    fontSize: string;
    opacity: string;
  }
  export interface MiniWindow {
    document: MiniDocument;
    getComputedStyle(el: MiniElement): MiniStyle;
    close(): void;
  }
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    window: MiniWindow;
  }
}
