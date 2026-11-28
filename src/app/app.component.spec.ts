import { provideRouter, RouterModule } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { IonicModule, Platform } from '@ionic/angular/lazy';
import { SplashScreen } from '@awesome-cordova-plugins/splash-screen/ngx';
import { StatusBar } from '@awesome-cordova-plugins/status-bar/ngx';
import { EMPTY } from 'rxjs';

import { AppComponent } from './app.component';

describe('AppComponent', () => {
  let fixture: ComponentFixture<AppComponent>;
  let platform: Platform;
  let platformReady: Promise<string>;
  let statusBar: jasmine.SpyObj<StatusBar>;
  let splashScreen: jasmine.SpyObj<SplashScreen>;

  beforeEach(waitForAsync(() => {
    statusBar = jasmine.createSpyObj('StatusBar', ['styleDefault']);
    splashScreen = jasmine.createSpyObj('SplashScreen', ['hide']);
    TestBed.configureTestingModule({
      declarations: [AppComponent],
      imports: [IonicModule.forRoot({ animated: false }), RouterModule],
      providers: [
        provideRouter([]),
        { provide: StatusBar, useValue: statusBar },
        { provide: SplashScreen, useValue: splashScreen },
        { provide: SwUpdate, useValue: { versionUpdates: EMPTY } }
      ]
    }).compileComponents();
  }));

  beforeEach(() => {
    platform = TestBed.inject(Platform);
    platformReady = Promise.resolve('dom');
    spyOn(platform, 'ready').and.returnValue(platformReady);
    fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
  });

  it('should create the app and render its navigation', () => {
    expect(fixture.componentInstance).toBeTruthy();
    expect(fixture.nativeElement.querySelector('#main-content')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('ion-menu').length).toBe(2);
  });

  it('should render the correct professional link titles', async () => {
    const app: HTMLElement = fixture.nativeElement;
    const labels = Array.from(app.querySelectorAll<HTMLIonLabelElement>('ion-menu[side="end"] ion-label'));
    // Ionic exposes slotted text through textContent after the labels render.
    await Promise.all(labels.map(label => label.componentOnReady()));
    const titles = labels.map(label => label.textContent?.trim());
    expect(titles).toContain('LinkedIn');
    expect(titles).toContain('GitHub');
  });

  it('should initialize the app', async () => {
    expect(platform.ready).toHaveBeenCalled();
    await platformReady;
    expect(statusBar.styleDefault).toHaveBeenCalled();
    expect(splashScreen.hide).toHaveBeenCalled();
  });
});
