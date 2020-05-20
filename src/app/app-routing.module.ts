import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { CheckTutorial } from './providers/check-tutorial.service';

const routes: Routes = [
  {
    path: '',
    redirectTo: '/',
    pathMatch: 'full'
  },
  // {
  //   path: 'account',
  //   loadChildren: () => import('./pages/account/account.module').then(m => m.AccountModule)
  // },
  // {
  //   path: 'support',
  //   loadChildren: () => import('./pages/support/support.module').then(m => m.SupportModule)
  // },
  // {
  //   path: 'login',
  //   loadChildren: () => import('./pages/login/login.module').then(m => m.LoginModule)
  // },
  // {
  //   path: 'signup',
  //   loadChildren: () => import('./pages/signup/signup.module').then(m => m.SignUpModule)
  // },
  // {
  //   path: 'app',
  //   loadChildren: () => import('./pages/tabs-page/tabs-page.module').then(m => m.TabsModule)
  // },
  {
    path: '',
    loadChildren: () => import('./pages/about/about.module').then(m => m.AboutModule)
  },
  {
    path: 'tutorial',
    loadChildren: () => import('./pages/tutorial/tutorial.module').then(m => m.TutorialModule),
    canLoad: [CheckTutorial]
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes, {useHash: true})],
  exports: [RouterModule]
})
export class AppRoutingModule {}
