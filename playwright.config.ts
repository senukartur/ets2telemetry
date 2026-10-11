import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests/electron',workers:1,retries:0,timeout:45000,globalTimeout:60000,expect:{timeout:10000},use:{trace:'retain-on-failure'}});
