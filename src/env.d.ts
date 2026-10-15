/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

declare module 'paper/dist/paper-core' {
  import paper from 'paper';
  export default paper;
}
