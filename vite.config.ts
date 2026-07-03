import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	server: { port: 4873, open: true },
	plugins: [sveltekit()]
});
