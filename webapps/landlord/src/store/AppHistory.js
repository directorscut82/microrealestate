export default class AppHistory {
  constructor(store) {
    this._store = store;
    this.previousPath = '/';
  }

  setPreviousPath(path) {
    this.previousPath = path;
    this._store.notify();
  }
}
