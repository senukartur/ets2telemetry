import {build} from 'vite';
import {builtinModules} from 'node:module';
await build({configFile:false,build:{outDir:'dist',emptyOutDir:true,lib:{entry:'src/cli.ts',formats:['cjs'],fileName:()=> 'cli.cjs'},rollupOptions:{external:[...builtinModules,...builtinModules.map(x=>`node:${x}`)]}}});
