import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import pkg from './package.json';

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' '))
	},
	server: { port: 4873, open: true },
	plugins: [sveltekit()]
});
