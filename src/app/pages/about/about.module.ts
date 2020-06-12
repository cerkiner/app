import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

import { AboutComponent } from './about.component';
import { AboutPageRoutingModule } from './about-routing.module';

@NgModule({
  imports: [
    CommonModule,
    IonicModule,
    AboutPageRoutingModule
  ],
  declarations: [AboutComponent],
  bootstrap: [AboutComponent],
})
export class AboutModule {}
