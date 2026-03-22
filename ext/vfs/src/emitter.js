class EventEmitter {
  constructor() {
    this._handlers = new Map();
  }
  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return this;
  }
  off(event, handler) {
    const set = this._handlers.get(event);
    if (set) set.delete(handler);
    return this;
  }
  emit(event, data) {
    const set = this._handlers.get(event);
    if (set) for (const fn of set) fn(data);
  }
}

export { EventEmitter };
