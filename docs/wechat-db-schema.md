# WeChat SQLCipher Database Schema Reference

## Summary

| Database | Tables | Category |
|----------|--------|----------|
| contact.db | 17 | Contacts & Social |
| contact_fts.db | 19 | Contacts & Social |
| bizchat.db | 4 | Contacts & Social |
| message_0.db | 11 | Messages |
| message_fts.db | 20 | Messages |
| message_resource.db | 7 | Messages |
| biz_message_0.db | 5 | Messages |
| session.db | 6 | Session & State |
| head_image.db | 1 | Media & Resources |
| media_0.db | 3 | Media & Resources |
| hardlink.db | 8 | Media & Resources |
| emoticon.db | 7 | Media & Resources |
| general.db | 14 | Other |
| favorite.db | 5 | Other |
| favorite_fts.db | 7 | Other |
| sns.db | 11 | Other |

**16 databases, 150 tables. All encrypted with SQLCipher AES-256-CBC (each DB has a different key).**

---

## Contacts & Social

### contact.db

Contact information: users, chat rooms, members, and group details.

| Table | Key Columns |
|-------|-------------|
| contact | username, alias, remark, nick_name, big_head_url, small_head_url |
| chatroom_member | room_id, member_id |
| chat_room | username, owner |
| chat_room_info_detail | username_, announcement_, chat_room_status_ |
| biz_info | username, type, brand_info, brand_icon_url |
| name2id | username |
| contact_label | label_name_, sort_order_ |
| oplog | buffer |
| stranger | username, alias, remark |

<details>
<summary>CREATE TABLE statements</summary>

```sql
CREATE TABLE contact(id INTEGER PRIMARY KEY, username TEXT, local_type INTEGER, alias TEXT, encrypt_username TEXT, flag INTEGER, delete_flag INTEGER, verify_flag INTEGER, remark TEXT, remark_quan_pin TEXT, remark_pin_yin_initial TEXT, nick_name TEXT, pin_yin_initial TEXT, quan_pin TEXT, big_head_url TEXT, small_head_url TEXT, head_img_md5 TEXT, chat_room_notify INTEGER, is_in_chat_room INTEGER, description TEXT, extra_buffer BLOB, chat_room_type INTEGER)

CREATE TABLE chatroom_member(room_id INTEGER, member_id INTEGER, CONSTRAINT room_member UNIQUE(room_id, member_id))

CREATE TABLE chat_room(id INTEGER PRIMARY KEY, username TEXT, owner TEXT, ext_buffer BLOB)

CREATE TABLE chat_room_info_detail(room_id_ INTEGER PRIMARY KEY, username_ TEXT, announcement_ TEXT, announcement_editor_ TEXT, announcement_publish_time_ INTEGER, chat_room_status_ INTEGER, xml_announcement_ TEXT, ext_buffer_ BLOB)

CREATE TABLE biz_info(id INTEGER PRIMARY KEY, username TEXT, type INTEGER, accept_type INTEGER, child_type INTEGER, version INTEGER, external_info TEXT, brand_info TEXT, brand_icon_url TEXT, brand_list TEXT, brand_flag INTEGER, belong TEXT, ext_buffer BLOB)

CREATE TABLE contact_label(label_id_ INTEGER PRIMARY KEY, label_name_ TEXT, sort_order_ INTEGER)

CREATE TABLE name2id(username TEXT PRIMARY KEY)
CREATE TABLE encrypt_name2id(username TEXT PRIMARY KEY)

CREATE TABLE stranger(id INTEGER PRIMARY KEY, username TEXT, local_type INTEGER, alias TEXT, encrypt_username TEXT, flag INTEGER, delete_flag INTEGER, verify_flag INTEGER, remark TEXT, remark_quan_pin TEXT, remark_pin_yin_initial TEXT, nick_name TEXT, pin_yin_initial TEXT, quan_pin TEXT, big_head_url TEXT, small_head_url TEXT, head_img_md5 TEXT, chat_room_notify INTEGER, is_in_chat_room INTEGER, description TEXT, extra_buffer BLOB, chat_room_type INTEGER)
CREATE TABLE stranger_ticket_info(id INTEGER PRIMARY KEY, ticket TEXT)
CREATE TABLE ticket_info(id INTEGER PRIMARY KEY, ticket TEXT)

CREATE TABLE oplog(id INTEGER PRIMARY KEY ASC AUTOINCREMENT, buffer BLOB)
```

</details>

---

### contact_fts.db

Full-text search indices for contacts. Pinyin-aware for Chinese name search.

| Table | Key Columns |
|-------|-------------|
| contact_fts_v2 (FTS5) | search_key, local_type |
| contact_fts_pinyin_v2 (FTS5) | search_key, local_type |
| chatroom_member_fts_v3 (FTS5) | a_group_remark, room_id, member_id |
| chatroom_member_fts_v3_aux | room_id, member_id |
| name2id | username |
| db_info | Key, ValueInt64, ValueStdStr |

<details>
<summary>CREATE TABLE statements</summary>

```sql
CREATE VIRTUAL TABLE contact_fts_v2 USING fts5(tokenize = 'MMFtsTokenizer disable_pinyin enable_special_char', search_key, local_type UNINDEXED)
CREATE VIRTUAL TABLE contact_fts_pinyin_v2 USING fts5(tokenize = 'MMFtsTokenizer disable_origin', content='contact_fts_v2', search_key, local_type UNINDEXED)
CREATE VIRTUAL TABLE chatroom_member_fts_v3 USING fts5(tokenize = 'MMFtsTokenizer disable_pinyin enable_special_char', a_group_remark, room_id UNINDEXED, member_id UNINDEXED)
CREATE TABLE chatroom_member_fts_v3_aux(room_id INTEGER, member_id INTEGER, CONSTRAINT room_member UNIQUE(room_id, member_id))
CREATE TABLE db_info(Key TEXT PRIMARY KEY, ValueInt64 INTEGER, ValueDouble REAL, ValueStdStr TEXT, ValueBlob BLOB)
CREATE TABLE name2id(username TEXT PRIMARY KEY)
```

</details>

---

### bizchat.db

Business/brand chat info for official accounts.

| Table | Key Columns |
|-------|-------------|
| chat_group | group_id, brand_user_name, chat_name |
| user_info | user_id, brand_user_name, user_name |
| my_user_info | brand_user_name, user_id |
| name2id | username |

---

## Messages

### message_0.db

Primary message storage. Per-chat message tables are sharded by chat ID hash.

| Table | Key Columns |
|-------|-------------|
| Msg_{hash} | local_id, server_id, local_type, create_time, message_content, real_sender_id |
| Name2Id | user_name, is_session |
| SendInfo | chat_name_id, msg_local_id |
| DeleteInfo | chat_name_id, delete_table_name |
| DeleteResInfo | session_name_id, res_path |
| HistoryAddMsgInfo | session_name_id, history_id, server_id |
| TimeStamp | timestamp |

Message table schema (each `Msg_{hash}` table):

```sql
CREATE TABLE Msg_{hash}(
  local_id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER,
  local_type INTEGER,
  sort_seq INTEGER,
  real_sender_id INTEGER,
  create_time INTEGER,
  status INTEGER,
  upload_status INTEGER,
  download_status INTEGER,
  server_seq INTEGER,
  origin_source INTEGER,
  source TEXT,
  message_content TEXT,
  compress_content TEXT,
  packed_info_data BLOB,
  WCDB_CT_message_content INTEGER DEFAULT NULL,
  WCDB_CT_source INTEGER DEFAULT NULL
)
```

---

### message_fts.db

Full-text search for messages. Sharded into 4 time-range indices.

| Table | Key Columns |
|-------|-------------|
| message_fts_v4_{0-3} (FTS5) | acontent, message_local_id, session_id, create_time |
| message_fts_v4_aux_{0-3} | message_local_id, sort_seq, session_id |
| message_fts_v4_range | session_id, db_time_stamp, range_type |
| name2id | username |

---

### message_resource.db

Message attachment metadata (files, images, video, audio).

| Table | Key Columns |
|-------|-------------|
| MessageResourceInfo | message_id, chat_id, sender_id, create_time |
| MessageResourceDetail | resource_id, message_id, type, size, status |
| ChatName2Id | user_name |
| SenderName2Id | user_name |
| FtsRange | session_id, db_time_stamp |
| FtsDeleteInfo | session_id, max_message_id |

---

### biz_message_0.db

Business account messages. Same structure as message_0.db but for official accounts.

| Table | Key Columns |
|-------|-------------|
| Name2Id | user_name, is_session |
| TimeStamp | timestamp |
| DeleteInfo | chat_name_id |
| DeleteResInfo | session_name_id |

---

## Session & State

### session.db

Chat session metadata, unread counts, drafts.

| Table | Key Columns |
|-------|-------------|
| SessionTable | username, type, unread_count, last_msg_sender, last_timestamp, summary, draft |
| Name2Id | user_name |
| SessionUnreadListTable_1 | username_id, server_id |
| SessionUnreadStatTable_1 | username_id, unread_stat |
| SessionDeleteTable | username, delete_time |
| SessionNoContactInfoTable | username, session_title |

<details>
<summary>CREATE TABLE statements</summary>

```sql
CREATE TABLE SessionTable(username TEXT PRIMARY KEY, type INTEGER, unread_count INTEGER, unread_first_msg_srv_id INTEGER, unread_first_pat_msg_local_id INTEGER, unread_first_pat_msg_sort_seq INTEGER, is_hidden INTEGER, summary TEXT, draft TEXT, status INTEGER, last_timestamp INTEGER, sort_timestamp INTEGER, last_clear_unread_timestamp INTEGER, last_msg_locald_id INTEGER, last_msg_type INTEGER, last_msg_sub_type INTEGER, last_msg_sender TEXT, last_sender_display_name TEXT, last_msg_ext_type INTEGER)
```

</details>

---

## Media & Resources

### head_image.db

Avatar/profile image cache.

| Table | Key Columns |
|-------|-------------|
| head_image | username, md5, image_buffer (BLOB), update_time |

### media_0.db

Voice/audio message binary storage.

| Table | Key Columns |
|-------|-------------|
| VoiceInfo | chat_name_id, create_time, local_id, voice_data (BLOB) |
| Name2Id | user_name |
| TimeStamp | timestamp |

### hardlink.db

File deduplication via hardlinks for images, videos, files.

| Table | Key Columns |
|-------|-------------|
| image_hardlink_info_v4 | md5, file_name, file_size, modify_time |
| video_hardlink_info_v4 | md5, file_name, file_size, modify_time |
| file_hardlink_info_v4 | md5, file_name, file_size, modify_time |
| dir2id | username |
| db_info | Key, ValueInt64 |

### emoticon.db

Emoji/sticker packs and favorites.

| Table | Key Columns |
|-------|-------------|
| kStoreEmoticonPackageTable | package_id_, package_name_, download_status_ |
| kStoreEmoticonFilesTable | package_id_, md5_, type_, sort_order_ |
| kStoreEmoticonCaptionsTable | package_id_, md5_, language_, caption_ |
| kNonStoreEmoticonTable | type, md5, caption, cdn_url |
| kFavEmoticonOrderTable | md5 |

---

## Other

### general.db

Miscellaneous app state: payments, notifications, moments.

| Table | Key Columns |
|-------|-------------|
| FMessageTable | user_name_, type_, timestamp_, content_ |
| revokemessage | to_user_name, svr_id, revoke_time |
| redEnvelopeTable | session_name, sender_user_name |
| transferTable | transfer_id, transcation_id |
| wacontact | user_name, type |
| wcfinderlivestatus | finder_username, live_status |
| websearch_record | keyword, create_time |
| *(7 more tables)* | — |

### favorite.db

Bookmarked content with tagging.

| Table | Key Columns |
|-------|-------------|
| fav_db_item | local_id, server_id, type, content |
| fav_tag_db_item | local_id, server_id, name |
| fav_bind_tag_db_item | tag_local_id, fav_local_id |

### sns.db

Moments/social feed.

| Table | Key Columns |
|-------|-------------|
| SnsTimeLine | tid, user_name, content |
| SnsTopItem_1 | tid, username, summary, create_time |
| SnsMessage_tmp3 | from_username, to_username, content |
| SnsDraft | create_time, ui_type, content |

---

## Design Patterns

- **Sharded message tables**: `Msg_{hash}` tables per chat for horizontal scaling
- **FTS5 with MMFtsTokenizer**: Pinyin-aware full-text search for Chinese
- **WCDB compression**: `wcdb_builtin_compression_record` tracks compressed columns
- **Name2Id mapping**: Most DBs have a `name2id` table mapping usernames to integer IDs
- **Key-value stores**: `db_info`, `table_info`, `buff`, `config` tables for flexible metadata
- **Checkpoint tables**: Track sync progress across time periods
