export default class AppHistory {
  constructor() {
    this.previousPath = '/';
  }

  setPreviousPath(path) {
    this.previousPath = path;
  }
}
