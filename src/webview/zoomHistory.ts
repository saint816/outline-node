// zoom 前进/后退历史（纯 webview 内存态）。所有「记录历史」的导航走 go()，
// back()/forward() 只重放不记录。apply 落到 store.zoomTo（自身会去重/校验）。

export class ZoomHistory {
  private stack: (string | null)[] = [null];
  private idx = 0;

  constructor(private readonly apply: (id: string | null) => void) {}

  /** 用户主动导航：截断前进分支、压栈、应用。 */
  go(id: string | null): void {
    if (this.stack[this.idx] === id) return;
    this.stack = this.stack.slice(0, this.idx + 1);
    this.stack.push(id);
    this.idx = this.stack.length - 1;
    this.apply(id);
  }

  back(): void {
    if (this.idx <= 0) return;
    this.idx--;
    this.apply(this.stack[this.idx]);
  }

  forward(): void {
    if (this.idx >= this.stack.length - 1) return;
    this.idx++;
    this.apply(this.stack[this.idx]);
  }

  canBack(): boolean {
    return this.idx > 0;
  }

  canForward(): boolean {
    return this.idx < this.stack.length - 1;
  }
}
