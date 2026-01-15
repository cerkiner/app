import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { AboutComponent } from './about.component';

describe('About', () => {
    let component: AboutComponent;
    let fixture: ComponentFixture<AboutComponent>;

    beforeEach(waitForAsync(() => {
        TestBed.configureTestingModule({
            declarations: [AboutComponent]
        })
            .compileComponents();
    }));

    beforeEach(() => {
        fixture = TestBed.createComponent(AboutComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('should render the photo', waitForAsync(() => {
        const compiled = fixture.debugElement.nativeElement;
        expect(compiled.querySelector('img.about-image').src).toContain('/assets/img/me_square.jpg');
    }));

    it('should render the text', waitForAsync(() => {
        const compiled = fixture.debugElement.nativeElement;
        expect(compiled.querySelector('div.about-info').innerText.length).toBeGreaterThan(1);
    }));
});
