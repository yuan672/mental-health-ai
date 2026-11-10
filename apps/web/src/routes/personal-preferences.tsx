import { DIARY_CAT_VALUES, type DiaryCat, type PersonalSettings } from '@mental-health/types';
import { useEffect, useRef, useState } from 'react';
import { usePersonalSettings } from '../app/personal-settings';
import { CatArt, cats } from '../shared/cat-art';
import { ProfileAvatar } from '../shared/profile-avatar';

type SaveNotice = { kind: 'success' | 'error'; message: string } | null;

function PreferencesForm({
  data,
  save,
  busy,
  notice,
  onEdit,
}: {
  data: PersonalSettings;
  save: (patch: Partial<Omit<PersonalSettings, 'revision'>>, file?: File) => Promise<void>;
  busy: boolean;
  notice: SaveNotice;
  onEdit: () => void;
}) {
  const [name, setName] = useState(data.displayName),
    [cat, setCat] = useState<DiaryCat>(data.cat),
    [biography, setBiography] = useState(data.biography),
    [avatarId, setAvatarId] = useState(data.avatarId),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<string | null>(null),
    [imageError, setImageError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const customAvatar = Boolean(file || avatarId);
  const nameLength = Array.from(name.trim()).length;
  const bioLength = Array.from(biography.trim()).length;
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);
  function chooseCat(mood: DiaryCat) {
    setCat(mood);
    setFile(null);
    setPreview(null);
    setAvatarId(null);
    setImageError(null);
    onEdit();
  }
  return (
    <form
      className="profile-card preferences-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || nameLength > 24 || bioLength > 200) return;
        void save(
          { displayName: name.trim(), cat, biography: biography.trim(), avatarId },
          file ?? undefined,
        );
      }}
    >
      <h2>给自己的小角落添一点喜欢</h2>
      <p className="muted">一张喜欢的头像，一个舒服的称呼，还有一点关于你的故事。</p>
      <div className="profile-avatar-editor">
        <ProfileAvatar cat={cat} avatarId={avatarId} preview={file ? preview : null} />
        <div className="profile-avatar-controls">
          <strong>{name.trim() || '今天，也要好好照顾自己'}</strong>
          <p className="muted">{customAvatar ? '你的专属头像' : '让这只小猫代表你'}</p>
          <div className="profile-avatar-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => picker.current?.click()}
            >
              {customAvatar ? '更换头像' : '上传自己的头像'}
            </button>
            {customAvatar ? (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => chooseCat(cat)}
              >
                换回小猫头像
              </button>
            ) : null}
          </div>
          <input
            ref={picker}
            className="profile-avatar-file"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-label="上传头像图片"
            disabled={busy}
            onChange={(event) => {
              const image = event.target.files?.[0];
              event.target.value = '';
              if (!image) return;
              if (
                !['image/jpeg', 'image/png', 'image/webp'].includes(image.type) ||
                image.size > 5 * 1024 * 1024 ||
                !image.size
              ) {
                setImageError('请选择 5 MB 以内的 JPG、PNG 或 WebP 图片');
                return;
              }
              setPreview(URL.createObjectURL(image));
              setFile(image);
              setAvatarId(null);
              setImageError(null);
              onEdit();
            }}
          />
          <small className="muted">JPG、PNG、WebP · 最大 5 MB，保存后生效</small>
        </div>
      </div>
      {imageError ? (
        <p role="alert" className="inline-error">
          {imageError}
        </p>
      ) : null}
      <label htmlFor="display-name">怎么称呼你（选填）</label>
      <input
        id="display-name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          onEdit();
        }}
        placeholder="一个让你舒服的昵称"
        disabled={busy}
      />
      <p className="muted">不必填写真实姓名，最多 24 字。</p>
      <fieldset disabled={busy}>
        <legend>选一只小猫作为头像</legend>
        <div className="profile-cat-choices">
          {DIARY_CAT_VALUES.map((mood) => (
            <label className={!customAvatar && cat === mood ? 'chosen' : ''} key={mood}>
              <input
                type="radio"
                name="profile-cat"
                value={mood}
                checked={!customAvatar && cat === mood}
                onChange={() => chooseCat(mood)}
              />
              <CatArt mood={mood} />
              <span>{cats[mood].label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="profile-biography-field">
        <label htmlFor="profile-biography">个人简介（选填）</label>
        <textarea
          id="profile-biography"
          rows={4}
          value={biography}
          disabled={busy}
          placeholder="喜欢什么、最近的小愿望……写一点关于自己的故事吧。"
          aria-describedby="profile-biography-count"
          onChange={(event) => {
            setBiography(event.target.value);
            onEdit();
          }}
        />
        <div className="profile-biography-hint">
          <span className="muted">慢慢认识自己，从一小段介绍开始。</span>
          <span id="profile-biography-count" className={bioLength > 200 ? 'inline-error' : 'muted'}>
            {bioLength} / 200
          </span>
        </div>
      </div>
      <button
        type="submit"
        className="button"
        disabled={busy || nameLength > 24 || bioLength > 200}
      >
        {busy ? '正在保存…' : '保存个人设置'}
      </button>
      {notice ? (
        <p
          role={notice.kind === 'success' ? 'status' : 'alert'}
          className={notice.kind === 'success' ? 'success-note' : 'inline-error'}
        >
          {notice.message}
        </p>
      ) : null}
    </form>
  );
}
export function PersonalPreferences() {
  const settings = usePersonalSettings();
  // The form is intentionally replaced on a new server revision; its acknowledgement must survive.
  const [notice, setNotice] = useState<SaveNotice>(null);
  if (!settings) return null;
  const save = async (patch: Partial<Omit<PersonalSettings, 'revision'>>, file?: File) => {
    setNotice(null);
    try {
      await settings.update(patch, file);
      setNotice({ kind: 'success', message: '已经保存好了。' });
    } catch (reason) {
      setNotice({
        kind: 'error',
        message: reason instanceof Error ? reason.message : '保存暂时没有完成',
      });
    }
  };
  return (
    <>
      <h2 className="settings-heading">你的专属设置</h2>
      {settings.error ? (
        <div className="inline-error" role="alert">
          {settings.error}
          <button
            className="text-button"
            disabled={settings.busy}
            onClick={() => {
              setNotice(null);
              void settings.reload();
            }}
          >
            重新读取设置
          </button>
        </div>
      ) : null}
      {settings.data ? (
        <PreferencesForm
          key={settings.data.revision}
          data={settings.data}
          save={save}
          busy={settings.busy}
          notice={notice}
          onEdit={() => setNotice(null)}
        />
      ) : (
        <p>正在读取个人设置…</p>
      )}
    </>
  );
}
