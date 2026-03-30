import { action, makeObservable, observable } from 'mobx';

export default class AppHistory {
  constructor() {
    this.previousPath = '/';

    makeObservable(this, {
      previousPath: observable,
      setPreviousPath: action
    });
  }

  setPreviousPath(path) {
    this.previousPath = path;
  }
}
