export type PublicationLanguage = 'en' | 'vi';
export type ContentBlock = {type: 'paragraph' | 'note'; text: string} | {type: 'list'; title: string; items: string[]} | {type: 'cta'; label: string; href: string};
export interface Publication {id: string; title: string; intro: string; blocks: ContentBlock[]; language?: PublicationLanguage}
export interface PublishedContent extends Publication {author: 'website-marketer'; updatedAt: string}
export interface PublicationSelection {content: PublishedContent | null; requestedLanguage: PublicationLanguage; language: PublicationLanguage; fallback: boolean}
export function publicationLanguage(value?: unknown): PublicationLanguage;
export function validatePublication(value: unknown): Publication;
export function readPublication(directory: string, language?: PublicationLanguage): PublishedContent | null;
export function readPublicationSelection(directory: string, language?: PublicationLanguage): PublicationSelection;
export function publishPublication(directory: string, value: unknown, beforeCommit?: () => void): {id: string; duplicate: boolean; updatedAt: string};
export function preparePublication(directory: string, beforeCommit?: () => void): void;
