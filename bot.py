#!/usr/bin/env python3
"""
ShhhToshi Telegram Bot — Developed by ShhhDev

Admin (bot-side):
  Welcome: text / photo+text / GIF+text + Mini App button + extra URL buttons
  Broadcast: text, photo, GIF, sticker, video + optional inline URL buttons
  Flow: compose → preview to admin → /send to all users (or /cancel)
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    WebAppInfo,
    MenuButtonWebApp,
)
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    MessageHandler,
    ConversationHandler,
    ContextTypes,
    filters,
)
from telegram.constants import ParseMode
from telegram.error import TelegramError

# Load backend root .env (API + bot hosted together), then local bot/.env
_root = Path(__file__).resolve().parent.parent
load_dotenv(_root / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env")

BOT_TOKEN = os.getenv("BOT_TOKEN")
WEBAPP_URL = os.getenv("WEBAPP_URL")
ADMIN_IDS = {
    int(x.strip())
    for x in (os.getenv("ADMIN_TELEGRAM_IDS") or "").split(",")
    if x.strip().isdigit()
}

if not BOT_TOKEN:
    raise SystemExit("BOT_TOKEN is required in .env")
if not WEBAPP_URL:
    raise SystemExit("WEBAPP_URL is required in .env (HTTPS URL of your Mini App)")

DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(exist_ok=True)
WELCOME_PATH = DATA_DIR / "welcome.json"
USERS_PATH = DATA_DIR / "users.json"
DRAFT_PATH = DATA_DIR / "broadcast_draft.json"

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# Conversation states
(
    WAIT_WELCOME_TEXT,
    WAIT_WELCOME_MEDIA,
    WAIT_BUTTON,
    WAIT_BROADCAST_CONTENT,
    WAIT_BROADCAST_BUTTONS,
) = range(5)

DEFAULT_WELCOME = {
    "text": (
        "Welcome to ShhhToshi!\n\n"
        "Tap, upgrade, earn and climb the ranks.\n"
        "Open the Mini App below to start."
    ),
    "parse_mode": "HTML",
    "media_type": None,  # None | photo | animation | document
    "media_file_id": None,
    "open_button_text": "Open Mini App",
    "extra_buttons": [],
}


# ---------- Storage ----------

def load_welcome() -> dict:
    if WELCOME_PATH.exists():
        try:
            data = json.loads(WELCOME_PATH.read_text(encoding="utf-8"))
            base = DEFAULT_WELCOME.copy()
            base.update(data)
            if not isinstance(base.get("extra_buttons"), list):
                base["extra_buttons"] = []
            return base
        except Exception as e:
            logger.warning("welcome load: %s", e)
    return DEFAULT_WELCOME.copy()


def save_welcome(cfg: dict) -> None:
    WELCOME_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def load_users() -> set[int]:
    if USERS_PATH.exists():
        try:
            return set(json.loads(USERS_PATH.read_text(encoding="utf-8")))
        except Exception:
            return set()
    return set()


def save_users(users: set[int]) -> None:
    USERS_PATH.write_text(json.dumps(sorted(users)), encoding="utf-8")


def track_user(user_id: int) -> None:
    users = load_users()
    if user_id not in users:
        users.add(user_id)
        save_users(users)


def save_draft(draft: dict) -> None:
    DRAFT_PATH.write_text(json.dumps(draft, indent=2, ensure_ascii=False), encoding="utf-8")


def load_draft() -> Optional[dict]:
    if not DRAFT_PATH.exists():
        return None
    try:
        return json.loads(DRAFT_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None


def clear_draft() -> None:
    if DRAFT_PATH.exists():
        DRAFT_PATH.unlink()


def is_admin(user_id: Optional[int]) -> bool:
    return bool(user_id and user_id in ADMIN_IDS)


# ---------- Keyboards ----------

def build_welcome_keyboard(cfg: dict) -> InlineKeyboardMarkup:
    rows = [
        [
            InlineKeyboardButton(
                text=cfg.get("open_button_text") or "Open Mini App",
                web_app=WebAppInfo(url=WEBAPP_URL),
            )
        ]
    ]
    for btn in cfg.get("extra_buttons") or []:
        text = (btn.get("text") or "").strip()
        url = (btn.get("url") or "").strip()
        if text and url:
            rows.append([InlineKeyboardButton(text=text, url=url)])
    return InlineKeyboardMarkup(rows)


def build_url_keyboard(buttons: list[dict]) -> Optional[InlineKeyboardMarkup]:
    if not buttons:
        return None
    rows = []
    for btn in buttons:
        text = (btn.get("text") or "").strip()
        url = (btn.get("url") or "").strip()
        if text and url:
            rows.append([InlineKeyboardButton(text=text, url=url)])
    return InlineKeyboardMarkup(rows) if rows else None


# ---------- Send helpers ----------

async def send_payload(bot, chat_id: int, payload: dict, reply_markup=None) -> None:
    """Send a stored payload (welcome or broadcast draft) to one chat."""
    kind = payload.get("type") or "text"
    text = payload.get("text") or payload.get("caption") or None
    parse_mode = payload.get("parse_mode") or ParseMode.HTML
    file_id = payload.get("file_id")

    if kind == "photo" and file_id:
        await bot.send_photo(
            chat_id=chat_id,
            photo=file_id,
            caption=text,
            parse_mode=parse_mode if text else None,
            reply_markup=reply_markup,
        )
    elif kind == "animation" and file_id:
        await bot.send_animation(
            chat_id=chat_id,
            animation=file_id,
            caption=text,
            parse_mode=parse_mode if text else None,
            reply_markup=reply_markup,
        )
    elif kind == "video" and file_id:
        await bot.send_video(
            chat_id=chat_id,
            video=file_id,
            caption=text,
            parse_mode=parse_mode if text else None,
            reply_markup=reply_markup,
        )
    elif kind == "document" and file_id:
        await bot.send_document(
            chat_id=chat_id,
            document=file_id,
            caption=text,
            parse_mode=parse_mode if text else None,
            reply_markup=reply_markup,
        )
    elif kind == "sticker" and file_id:
        await bot.send_sticker(chat_id=chat_id, sticker=file_id, reply_markup=reply_markup)
        if text:
            await bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode=parse_mode,
                reply_markup=reply_markup,
            )
    else:
        await bot.send_message(
            chat_id=chat_id,
            text=text or "—",
            parse_mode=parse_mode,
            reply_markup=reply_markup,
            disable_web_page_preview=False,
        )


async def send_welcome_message(bot, chat_id: int, cfg: dict | None = None) -> None:
    cfg = cfg or load_welcome()
    keyboard = build_welcome_keyboard(cfg)
    payload = {
        "type": cfg.get("media_type") or "text",
        "file_id": cfg.get("media_file_id"),
        "text": cfg.get("text") or DEFAULT_WELCOME["text"],
        "parse_mode": cfg.get("parse_mode") or "HTML",
    }
    try:
        await send_payload(bot, chat_id, payload, reply_markup=keyboard)
    except TelegramError as e:
        logger.error("welcome fail %s: %s", chat_id, e)
        await bot.send_message(
            chat_id=chat_id,
            text=payload["text"],
            reply_markup=keyboard,
        )


def message_to_payload(msg) -> Optional[dict]:
    """Convert an incoming Telegram message into a broadcast/welcome payload."""
    if msg.photo:
        return {
            "type": "photo",
            "file_id": msg.photo[-1].file_id,
            "text": msg.caption or None,
            "parse_mode": "HTML",
        }
    if msg.animation:
        return {
            "type": "animation",
            "file_id": msg.animation.file_id,
            "text": msg.caption or None,
            "parse_mode": "HTML",
        }
    if msg.video:
        return {
            "type": "video",
            "file_id": msg.video.file_id,
            "text": msg.caption or None,
            "parse_mode": "HTML",
        }
    if msg.document:
        return {
            "type": "document",
            "file_id": msg.document.file_id,
            "text": msg.caption or None,
            "parse_mode": "HTML",
        }
    if msg.sticker:
        return {
            "type": "sticker",
            "file_id": msg.sticker.file_id,
            "text": None,
            "parse_mode": "HTML",
        }
    if msg.text:
        return {
            "type": "text",
            "file_id": None,
            "text": msg.text,
            "parse_mode": "HTML",
        }
    return None


def parse_button_lines(raw: str) -> list[dict]:
    """Parse lines like: Label | https://url"""
    buttons = []
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line or "|" not in line:
            continue
        left, right = line.split("|", 1)
        text, url = left.strip(), right.strip()
        if text and url.startswith("http"):
            buttons.append({"text": text, "url": url})
    return buttons


# ---------- User commands ----------

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not user:
        return
    track_user(user.id)
    try:
        await context.bot.set_chat_menu_button(
            chat_id=update.effective_chat.id,
            menu_button=MenuButtonWebApp(
                text="Play",
                web_app=WebAppInfo(url=WEBAPP_URL),
            ),
        )
    except Exception:
        pass
    await send_welcome_message(context.bot, update.effective_chat.id)


async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = "/start — Open Mini App welcome\n/help — Help\n"
    if is_admin(update.effective_user.id if update.effective_user else None):
        text += (
            "\n<b>Admin</b>\n"
            "/admin — Panel\n"
            "/setwelcome — Welcome text\n"
            "/setmedia — Welcome photo/GIF\n"
            "/clearmedia — Text-only welcome\n"
            "/addbutton — Extra URL button\n"
            "/listbuttons · /clearbuttons\n"
            "/setopenbtn — Mini App button label\n"
            "/preview — Preview welcome\n"
            "/broadcast — Compose broadcast\n"
            "/send — Send last broadcast draft\n"
            "/stats · /cancel\n"
        )
    await update.message.reply_text(text, parse_mode=ParseMode.HTML)


async def admin_only(update: Update) -> bool:
    uid = update.effective_user.id if update.effective_user else None
    if not is_admin(uid):
        await update.message.reply_text("Admin only.")
        return False
    return True


async def admin_panel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await admin_only(update):
        return
    cfg = load_welcome()
    draft = load_draft()
    msg = (
        "<b>ShhhToshi Admin</b> · ShhhDev\n\n"
        f"Users tracked: <b>{len(load_users())}</b>\n"
        f"Welcome media: <code>{cfg.get('media_type') or 'text only'}</code>\n"
        f"Extra buttons: <b>{len(cfg.get('extra_buttons') or [])}</b>\n"
        f"Broadcast draft: <b>{'yes — /send to deliver' if draft else 'none'}</b>\n\n"
        "<b>Welcome</b>\n"
        "/setwelcome — set text (HTML ok)\n"
        "/setmedia — photo or GIF (caption optional)\n"
        "/clearmedia — remove media\n"
        "/setopenbtn Label — Mini App button text\n"
        "/addbutton Label | https://url\n"
        "/listbuttons · /clearbuttons\n"
        "/preview — see welcome as users see it\n\n"
        "<b>Broadcast</b>\n"
        "/broadcast — send text / photo / GIF / sticker / video\n"
        "Then optionally add buttons, get <b>preview</b>\n"
        "/send — deliver draft to all users\n"
        "/cancel — abort"
    )
    await update.message.reply_text(msg, parse_mode=ParseMode.HTML)


async def stats_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await admin_only(update):
        return
    await update.message.reply_text(f"Tracked users: {len(load_users())}")


async def preview_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await admin_only(update):
        return
    await update.message.reply_text("Welcome preview:")
    await send_welcome_message(context.bot, update.effective_chat.id)


# ---------- Welcome text ----------

async def setwelcome_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if not await admin_only(update):
        return ConversationHandler.END
    await update.message.reply_text(
        "Send the new welcome <b>text</b> (HTML ok).\n/cancel to abort.",
        parse_mode=ParseMode.HTML,
    )
    return WAIT_WELCOME_TEXT


async def setwelcome_save(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text = (update.message.text or "").strip()
    if not text:
        await update.message.reply_text("Empty. Send text or /cancel.")
        return WAIT_WELCOME_TEXT
    cfg = load_welcome()
    cfg["text"] = text
    cfg["parse_mode"] = "HTML"
    save_welcome(cfg)
    await update.message.reply_text("Welcome text saved. /preview to check.")
    return ConversationHandler.END


# ---------- Welcome media ----------

async def setmedia_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if not await admin_only(update):
        return ConversationHandler.END
    await update.message.reply_text(
        "Send a <b>photo</b> or <b>GIF</b> for welcome.\n"
        "Optional caption becomes the welcome text.\n/cancel to abort.",
        parse_mode=ParseMode.HTML,
    )
    return WAIT_WELCOME_MEDIA


async def setmedia_save(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    msg = update.message
    cfg = load_welcome()
    payload = message_to_payload(msg)
    if not payload or payload["type"] not in ("photo", "animation", "document"):
        await msg.reply_text("Send a photo or GIF, or /cancel.")
        return WAIT_WELCOME_MEDIA

    cfg["media_type"] = payload["type"]
    cfg["media_file_id"] = payload["file_id"]
    if payload.get("text"):
        cfg["text"] = payload["text"]
        cfg["parse_mode"] = "HTML"
    save_welcome(cfg)
    await msg.reply_text(
        f"Welcome {payload['type']} saved"
        + (" (caption used as text)." if payload.get("text") else ".")
        + " /preview to check."
    )
    return ConversationHandler.END


async def clearmedia_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await admin_only(update):
        return
    cfg = load_welcome()
    cfg["media_type"] = None
    cfg["media_file_id"] = None
    save_welcome(cfg)
    await update.message.reply_text("Welcome media cleared (text-only).")


async def setopenbtn_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await admin_only(update):
        return
    label = " ".join(context.args).strip() if context.args else ""
    if not label:
        await update.message.reply_text("Usage: /setopenbtn Open Mini App")
        return
    cfg = load_welcome()
    cfg["open_button_text"] = label[:64]
    save_welcome(cfg)
    await update.message.reply_text(f"Open button: {cfg['open_button_text']}")


# ---------- Extra welcome buttons ----------

async def addbutton_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if not await admin_only(update):
        return ConversationHandler.END
    if context.args:
        raw = " ".join(context.args)
        if "|" in raw:
            left, right = raw.split("|", 1)
            text, url = left.strip(), right.strip()
            if text and url.startswith("http"):
                cfg = load_welcome()
                cfg.setdefault("extra_buttons", []).append({"text": text, "url": url})
                save_welcome(cfg)
                await update.message.reply_text(f"Button added: {text}")
                return ConversationHandler.END
        await update.message.reply_text("Format: /addbutton Label | https://example.com")
        return ConversationHandler.END

    await update.message.reply_text(
        "Send: <code>Button label | https://example.com</code>\n/cancel to abort.",
        parse_mode=ParseMode.HTML,
    )
    return WAIT_BUTTON


async def addbutton_save(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    buttons = parse_button_lines(update.message.text or "")
    if not buttons:
        await update.message.reply_text("Need: Label | https://url")
        return WAIT_BUTTON
    cfg = load_welcome()
    cfg.setdefault("extra_buttons", []).extend(buttons)
    save_welcome(cfg)
    await update.message.reply_text(
        f"Added {len(buttons)} button(s). Total: {len(cfg['extra_buttons'])}"
    )
    return ConversationHandler.END


async def listbuttons_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await admin_only(update):
        return
    btns = load_welcome().get("extra_buttons") or []
    if not btns:
        await update.message.reply_text("No extra buttons.")
        return
    lines = [f"{i+1}. {b.get('text')} → {b.get('url')}" for i, b in enumerate(btns)]
    await update.message.reply_text("Extra buttons:\n" + "\n".join(lines))


async def clearbuttons_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await admin_only(update):
        return
    cfg = load_welcome()
    cfg["extra_buttons"] = []
    save_welcome(cfg)
    await update.message.reply_text("All extra welcome buttons removed.")


# ---------- Broadcast: compose → preview → /send ----------

async def broadcast_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if not await admin_only(update):
        return ConversationHandler.END
    clear_draft()
    n = len(load_users())
    await update.message.reply_text(
        f"Broadcast to <b>{n}</b> users.\n\n"
        "Send the content now:\n"
        "• Text\n"
        "• Photo (+ optional caption)\n"
        "• GIF / animation\n"
        "• Sticker\n"
        "• Video / document\n\n"
        "After that you can add inline buttons, then you'll get a <b>preview</b>.\n"
        "Use /send to deliver, or /cancel.",
        parse_mode=ParseMode.HTML,
    )
    return WAIT_BROADCAST_CONTENT


async def broadcast_content(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    payload = message_to_payload(update.message)
    if not payload:
        await update.message.reply_text(
            "Unsupported. Send text, photo, GIF, sticker, or video — or /cancel."
        )
        return WAIT_BROADCAST_CONTENT

    draft = {
        "payload": payload,
        "buttons": [],
    }
    save_draft(draft)
    context.user_data["broadcast_draft"] = draft

    await update.message.reply_text(
        "Content saved.\n\n"
        "Optional: send inline buttons now, one per line:\n"
        "<code>Channel | https://t.me/xxx</code>\n"
        "<code>Twitter | https://x.com/xxx</code>\n\n"
        "Or send /skip to preview without buttons.",
        parse_mode=ParseMode.HTML,
    )
    return WAIT_BROADCAST_BUTTONS


async def broadcast_buttons_or_skip(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text = (update.message.text or "").strip()
    draft = load_draft() or context.user_data.get("broadcast_draft")
    if not draft:
        await update.message.reply_text("No draft. Start with /broadcast.")
        return ConversationHandler.END

    if text.lower() not in ("/skip", "skip"):
        buttons = parse_button_lines(text)
        if not buttons and "|" in text:
            await update.message.reply_text(
                "Could not parse buttons. Use:\nLabel | https://url\nor /skip"
            )
            return WAIT_BROADCAST_BUTTONS
        draft["buttons"] = buttons
        save_draft(draft)

    # Preview to admin
    kb = build_url_keyboard(draft.get("buttons") or [])
    await update.message.reply_text(
        f"<b>PREVIEW</b> (only you see this)\n"
        f"Type: <code>{draft['payload'].get('type')}</code>\n"
        f"Buttons: <b>{len(draft.get('buttons') or [])}</b>\n"
        f"Recipients: <b>{len(load_users())}</b>\n\n"
        "If it looks good, send <b>/send</b>\n"
        "To discard: /cancel",
        parse_mode=ParseMode.HTML,
    )
    try:
        await send_payload(
            context.bot,
            update.effective_chat.id,
            draft["payload"],
            reply_markup=kb,
        )
    except TelegramError as e:
        await update.message.reply_text(f"Preview failed: {e}")
        return ConversationHandler.END

    return ConversationHandler.END


async def broadcast_skip(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Handle /skip during button step."""
    draft = load_draft() or context.user_data.get("broadcast_draft")
    if not draft:
        await update.message.reply_text("No draft. /broadcast first.")
        return ConversationHandler.END
    draft["buttons"] = draft.get("buttons") or []
    save_draft(draft)
    kb = build_url_keyboard(draft.get("buttons") or [])
    await update.message.reply_text(
        f"<b>PREVIEW</b>\nType: <code>{draft['payload'].get('type')}</code>\n"
        f"Buttons: 0\nRecipients: <b>{len(load_users())}</b>\n\n"
        "Send <b>/send</b> to deliver, or /cancel.",
        parse_mode=ParseMode.HTML,
    )
    try:
        await send_payload(context.bot, update.effective_chat.id, draft["payload"], reply_markup=kb)
    except TelegramError as e:
        await update.message.reply_text(f"Preview failed: {e}")
    return ConversationHandler.END


async def send_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Deliver the current broadcast draft to all tracked users."""
    if not await admin_only(update):
        return
    draft = load_draft()
    if not draft or not draft.get("payload"):
        await update.message.reply_text("No draft. Use /broadcast first, then /send.")
        return

    users = list(load_users())
    if not users:
        await update.message.reply_text("No users tracked yet.")
        return

    kb = build_url_keyboard(draft.get("buttons") or [])
    await update.message.reply_text(f"Sending to {len(users)} users…")

    ok, fail = 0, 0
    for uid in users:
        try:
            await send_payload(context.bot, uid, draft["payload"], reply_markup=kb)
            ok += 1
        except Exception as e:
            logger.debug("broadcast fail %s: %s", uid, e)
            fail += 1

    clear_draft()
    await update.message.reply_text(
        f"Broadcast finished.\n✅ Sent: {ok}\n❌ Failed: {fail}\nDraft cleared."
    )


async def cancel_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    clear_draft()
    await update.message.reply_text("Cancelled. Draft cleared.")
    return ConversationHandler.END


def main() -> None:
    if not WELCOME_PATH.exists():
        save_welcome(DEFAULT_WELCOME)

    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("admin", admin_panel))
    app.add_handler(CommandHandler("stats", stats_cmd))
    app.add_handler(CommandHandler("preview", preview_cmd))
    app.add_handler(CommandHandler("clearmedia", clearmedia_cmd))
    app.add_handler(CommandHandler("setopenbtn", setopenbtn_cmd))
    app.add_handler(CommandHandler("listbuttons", listbuttons_cmd))
    app.add_handler(CommandHandler("clearbuttons", clearbuttons_cmd))
    app.add_handler(CommandHandler("send", send_cmd))

    app.add_handler(
        ConversationHandler(
            entry_points=[CommandHandler("setwelcome", setwelcome_start)],
            states={
                WAIT_WELCOME_TEXT: [
                    MessageHandler(filters.TEXT & ~filters.COMMAND, setwelcome_save)
                ],
            },
            fallbacks=[CommandHandler("cancel", cancel_cmd)],
        )
    )
    app.add_handler(
        ConversationHandler(
            entry_points=[CommandHandler("setmedia", setmedia_start)],
            states={
                WAIT_WELCOME_MEDIA: [
                    MessageHandler(
                        filters.PHOTO | filters.ANIMATION | filters.Document.IMAGE,
                        setmedia_save,
                    )
                ],
            },
            fallbacks=[CommandHandler("cancel", cancel_cmd)],
        )
    )
    app.add_handler(
        ConversationHandler(
            entry_points=[CommandHandler("addbutton", addbutton_start)],
            states={
                WAIT_BUTTON: [
                    MessageHandler(filters.TEXT & ~filters.COMMAND, addbutton_save)
                ],
            },
            fallbacks=[CommandHandler("cancel", cancel_cmd)],
        )
    )
    app.add_handler(
        ConversationHandler(
            entry_points=[CommandHandler("broadcast", broadcast_start)],
            states={
                WAIT_BROADCAST_CONTENT: [
                    MessageHandler(
                        (
                            filters.TEXT
                            | filters.PHOTO
                            | filters.ANIMATION
                            | filters.STICKER
                            | filters.VIDEO
                            | filters.Document.ALL
                        )
                        & ~filters.COMMAND,
                        broadcast_content,
                    )
                ],
                WAIT_BROADCAST_BUTTONS: [
                    CommandHandler("skip", broadcast_skip),
                    MessageHandler(filters.TEXT & ~filters.COMMAND, broadcast_buttons_or_skip),
                ],
            },
            fallbacks=[CommandHandler("cancel", cancel_cmd)],
        )
    )

    logger.info("ShhhToshi bot starting · admins=%s · ShhhDev", ADMIN_IDS or "(none)")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
