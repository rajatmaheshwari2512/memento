import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/table/remote/asset.dart';
import 'package:immich_mobile/data/db/util/defaults_mixin.dart';

@TableIndex.sql(
  'CREATE INDEX IF NOT EXISTS idx_remote_asset_storage_saver_original_checksum ON remote_asset_storage_saver_entity (original_checksum)',
)
class RemoteAssetStorageSaverEntity extends Table with DriftDefaultsMixin {
  TextColumn get assetId => text().references(RemoteAssetEntity, #id, onDelete: KeyAction.cascade)();

  TextColumn get originalChecksum => text()();

  @override
  Set<Column> get primaryKey => {assetId};
}
