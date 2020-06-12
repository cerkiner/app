import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';

import { About } from './about';
import { AboutPageRoutingModule } from './about-routing.module';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    AboutPageRoutingModule
  ],
  declarations: [About],
  bootstrap: [About],
})
export class AboutModule {}
