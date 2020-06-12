import { async, ComponentFixture, TestBed } from '@angular/core/testing';

import { About } from './about';

describe('About', () => {
    let component: About;
    let fixture: ComponentFixture<About>;

    beforeEach(async(() => {
        TestBed.configureTestingModule({
            declarations: [About]
        })
            .compileComponents();
    }));

    beforeEach(() => {
        fixture = TestBed.createComponent(About);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('should render the photo', async(() => {
        const compiled = fixture.debugElement.nativeElement;
        expect(compiled.querySelector('img.about-image').src).toContain('/assets/img/me_square.jpg');
    }));

    it('should render the text', async(() => {
        const compiled = fixture.debugElement.nativeElement;
        expect(compiled.querySelector('div.about-info').innerText.length).toBeGreaterThan(1);
    }));
});
