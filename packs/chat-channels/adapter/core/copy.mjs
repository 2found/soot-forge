// The adapter's own sentences, by language. Codes come from the host or the
// adapter; the words are the adapter's (the runtime core is language-generic).
// The language is the session's binding.language, else Vietnamese.
const COPY = {
  vi: {
    image_too_large: 'Ảnh này nặng quá (tối đa 2 MB mỗi ảnh). Bạn gửi ảnh nhỏ hơn nhé.',
    image_unreadable: 'Mình chưa tải được ảnh này. Bạn gửi lại giúp mình nhé.',
    images_too_many: 'Tin này nhiều ảnh quá để gửi một lần. Bạn chia ra vài tin nhé.',
  },
  en: {
    image_too_large: 'That picture is too large (2 MB at most each). Please send a smaller one.',
    image_unreadable: 'I could not download that picture. Please send it again.',
    images_too_many: 'Too many pictures for one message. Please split them over a few messages.',
  },
};

export function languageOf(session) {
  const lang = String(session?.binding?.language ?? '').toLowerCase().split(/[-_]/)[0];
  return COPY[lang] ? lang : 'vi';
}

// The adapter's sentence for `code`, in the session's language.
export function say(session, code) {
  return COPY[languageOf(session)][code] ?? COPY.vi[code] ?? '';
}
