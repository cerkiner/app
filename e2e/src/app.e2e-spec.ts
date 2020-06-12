import { AppPage } from './app.po';

describe('new App', () => {
  let page: AppPage;

  beforeEach(() => {
    page = new AppPage();
  });

  it('should display the menus', () => {
    page.navigateTo();
    expect(page.getMenus()).toBeTruthy();
  });

  it('should get the first menu', () => {
    page.navigateTo();
    expect(page.getFirstMenu()).toBeTruthy();
  });

  it('should get the last menu', () => {
    page.navigateTo();
    expect(page.getFirstMenu()).toBeTruthy();
  });

  it('should create a router outlet', () => {
    page.navigateTo();
    expect(page.getRouter()).toBeTruthy();
  });

});
