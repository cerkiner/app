import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { Router } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { TestBed, waitForAsync } from '@angular/core/testing';

import { MenuController, Platform } from '@ionic/angular';
import { SplashScreen } from '@awesome-cordova-plugins/splash-screen/ngx';
import { StatusBar } from '@awesome-cordova-plugins/status-bar/ngx';
import { IonicStorageModule } from '@ionic/storage-angular';
import { AppComponent } from './app.component';
import { of } from 'rxjs';

describe('AppComponent', () => {
  let menuSpy,
    routerSpy,
    userDataSpy,
    statusBarSpy,
    splashScreenSpy,
    swUpdateSpy,
    platformReadySpy,
    platformSpy,
    app,
    fixture;

  beforeEach(waitForAsync(() => {
    menuSpy = jasmine.createSpyObj('MenuController', ['toggle', 'enable']);
    routerSpy = jasmine.createSpyObj('Router', ['navigateByUrl']);
    userDataSpy = jasmine.createSpyObj('UserData', ['isLoggedIn', 'logout']);
    statusBarSpy = jasmine.createSpyObj('StatusBar', ['styleDefault']);
    splashScreenSpy = jasmine.createSpyObj('SplashScreen', ['hide']);
    swUpdateSpy = {
      versionUpdates: of({
        type: 'VERSION_READY',
        currentVersion: { hash: 'old', appData: {} },
        latestVersion: { hash: 'new', appData: {} }
      }),
      activateUpdate: jasmine.createSpy('activateUpdate').and.returnValue(Promise.resolve())
    };
    platformReadySpy = Promise.resolve();
    platformSpy = jasmine.createSpyObj('Platform', { ready: platformReadySpy });

    TestBed.configureTestingModule({
      declarations: [AppComponent],
      imports: [IonicStorageModule.forRoot()],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
      providers: [
        { provide: MenuController, useValue: menuSpy },
        { provide: Router, useValue: routerSpy },
        { provide: StatusBar, useValue: statusBarSpy },
        { provide: SplashScreen, useValue: splashScreenSpy },
        { provide: SwUpdate, useValue: swUpdateSpy },
        { provide: Platform, useValue: platformSpy }
      ]
    }).compileComponents();
  }));
  beforeEach(() => {
    fixture = TestBed.createComponent(AppComponent);
    app = fixture.debugElement.componentInstance;
  });

  it('should create the app', () => {
    expect(app).toBeTruthy();
  });

  it('should initialize the app', async () => {
    expect(platformSpy.ready).toHaveBeenCalled();
    await platformReadySpy;
    expect(statusBarSpy.styleDefault).toHaveBeenCalled();
    expect(splashScreenSpy.hide).toHaveBeenCalled();
  });
});
