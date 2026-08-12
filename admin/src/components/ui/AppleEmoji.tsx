import { cn } from "@/lib/utils";

interface AppleEmojiProps {
  emoji: string;
  size?: number;
  className?: string;
}

/**
 * Renders an Apple-style emoji image via CDN for consistent cross-platform display.
 * Uses emojicdn.elk.sh which provides Apple emoji images.
 */
const AppleEmoji = ({ emoji, size = 24, className }: AppleEmojiProps) => {
  // Encode the emoji for URL safety
  const encodedEmoji = encodeURIComponent(emoji);
  
  return (
    <img
      src={`https://emojicdn.elk.sh/${encodedEmoji}?style=apple`}
      alt={emoji}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={cn("inline-block flex-shrink-0", className)}
      style={{ width: size, height: size }}
    />
  );
};

export default AppleEmoji;
