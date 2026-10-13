export interface UndoEntry<S> {
  label: string
  before: S
  after: S
}

/** Snapshot undo over immutable state: each entry restores an exact prior document. */
export class UndoHistory<S> {
  private past: UndoEntry<S>[] = []
  private future: UndoEntry<S>[] = []

  constructor(private readonly limit = 200) {}

  record(entry: UndoEntry<S>): void {
    if (entry.before === entry.after) return
    this.past.push(entry)
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }

  undo(): UndoEntry<S> | undefined {
    const entry = this.past.pop()
    if (entry) this.future.push(entry)
    return entry
  }

  redo(): UndoEntry<S> | undefined {
    const entry = this.future.pop()
    if (entry) this.past.push(entry)
    return entry
  }

  clear(): void {
    this.past = []
    this.future = []
  }

  get undoLabel(): string | undefined {
    return this.past[this.past.length - 1]?.label
  }

  get redoLabel(): string | undefined {
    return this.future[this.future.length - 1]?.label
  }
}
