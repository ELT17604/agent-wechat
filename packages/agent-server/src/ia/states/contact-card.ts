import type { IAState, FrameIdentifyMetadata, Action } from "../types.js";
import { querySelector, findAncestor } from "../selectors.js";

/**
 * Contact card - separate FSM for user profile cards.
 *
 * Separate from popup because:
 * - No OK/Confirm button (PopupActions.DISMISS doesn't work)
 * - Has its own action vocabulary
 *
 * Identification: Contains `label "WeChat ID:"` or `label "微信号:"`
 */
export const contactCardState: IAState<FrameIdentifyMetadata> = {
  fsm: "contactCard",
  id: "contact_card",

  identify: ({ a11y }) => {
    // Find "WeChat ID:" label - unique to contact cards
    // Support both English and Chinese locales
    const wechatIdLabel = querySelector(a11y, 'label[name=/^(WeChat ID:|微信号:)$/]');
    if (!wechatIdLabel) return { identified: false };

    // Find containing filler (the card root)
    const frame = findAncestor(wechatIdLabel, "filler");
    return { identified: true, metadata: frame ? { frame } : undefined };
  },

  reduce: ({ prev, a11y }) => {
    // Find WeChat ID label and its sibling with the actual ID
    const wechatIdLabel = querySelector(a11y, 'label[name=/^(WeChat ID:|微信号:)$/]');

    // The actual ID is in a sibling label right after "WeChat ID:"
    const parentFiller = wechatIdLabel?.parent;
    const children = parentFiller?.children ?? [];
    const labelIndex = children.findIndex(c =>
      c.name === "WeChat ID:" || c.name === "微信号:"
    );
    const idLabel = labelIndex >= 0 ? children[labelIndex + 1] : undefined;
    const wechatId = idLabel?.role === "label" ? idLabel.name : undefined;

    // Extract display name from the card header
    const nameLabel = querySelector(a11y, 'filler filler filler filler filler label');
    const contactName = nameLabel?.name;

    return {
      ...prev,
      contactCard: {
        wechatId,
        contactName,
      },
    };
  },
};

// Contact card specific actions
export const ContactCardActions = {
  DISMISS: { type: "key", combo: "Escape" } as Action,
  OPEN_MESSAGES: { type: "click", selector: 'push-button[name="Messages"]' } as Action,
  VOICE_CALL: { type: "click", selector: 'push-button[name="Voice Call"]' } as Action,
  VIDEO_CALL: { type: "click", selector: 'push-button[name="Video Call"]' } as Action,
  MORE: { type: "click", selector: 'push-button[name="More"]' } as Action,
} as const;
