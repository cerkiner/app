import { browser, by, element, ElementFinder, ExpectedConditions } from 'protractor';

export class AppPage {
  navigateTo() {
    return browser.get('/');
  }

  async getMenus() {
    const el = this.getElement('app-root ion-menu');
    await this.waitForSelector(el);
    return el;
  }

  async getFirstMenu() {
    const el = this.getElement('app-root ion-menu:first-child');
    await this.waitForSelector(el);
    return el;
  }

  async getLastMenu() {
    const el = this.getElement('app-root ion-menu:last-child');
    await this.waitForSelector(el);
    return el;
  }

  async getRouter() {
    const el = this.getElement('app-root ion-router-outlet');
    await this.waitForSelector(el);
    return el;
  }

  async waitForSelector(el: ElementFinder) {
    return browser.wait(ExpectedConditions.presenceOf(el), 5000);
  }

  getElement(selector) {
    return element(by.css(selector));
  }
}
