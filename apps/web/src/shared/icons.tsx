import type { ComponentProps } from 'react';
import {
  FiArrowLeft,
  FiArrowRight,
  FiBook,
  FiBookOpen,
  FiCheck,
  FiChevronLeft,
  FiChevronRight,
  FiChevronDown,
  FiClock,
  FiEdit3,
  FiEye,
  FiEyeOff,
  FiHeart,
  FiHome,
  FiImage,
  FiLock,
  FiLogOut,
  FiMail,
  FiMenu,
  FiMessageCircle,
  FiPlus,
  FiRefreshCw,
  FiSearch,
  FiSend,
  FiShield,
  FiStar,
  FiUser,
  FiX,
} from 'react-icons/fi';
import type { IconType } from 'react-icons';

type IconName =
  | 'arrow-left'
  | 'arrow-right'
  | 'book'
  | 'book-open'
  | 'check'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'clock'
  | 'edit'
  | 'eye'
  | 'eye-off'
  | 'heart'
  | 'home'
  | 'image'
  | 'lock'
  | 'log-out'
  | 'mail'
  | 'menu'
  | 'message'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'send'
  | 'shield'
  | 'sparkles'
  | 'user'
  | 'x';

const icons: Record<IconName, IconType> = {
  'arrow-left': FiArrowLeft,
  'arrow-right': FiArrowRight,
  book: FiBook,
  'book-open': FiBookOpen,
  check: FiCheck,
  'chevron-left': FiChevronLeft,
  'chevron-right': FiChevronRight,
  'chevron-down': FiChevronDown,
  clock: FiClock,
  edit: FiEdit3,
  eye: FiEye,
  'eye-off': FiEyeOff,
  heart: FiHeart,
  home: FiHome,
  image: FiImage,
  lock: FiLock,
  'log-out': FiLogOut,
  mail: FiMail,
  menu: FiMenu,
  message: FiMessageCircle,
  plus: FiPlus,
  refresh: FiRefreshCw,
  search: FiSearch,
  send: FiSend,
  shield: FiShield,
  sparkles: FiStar,
  user: FiUser,
  x: FiX,
};

export function Icon({ name, ...props }: ComponentProps<IconType> & { name: IconName }) {
  const FeatherIcon = icons[name];
  return <FeatherIcon aria-hidden="true" focusable="false" {...props} />;
}
