import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards, ParseUUIDPipe, UseInterceptors, UploadedFile, Res } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse, ApiConsumes } from '@nestjs/swagger';
import { InspectionsService } from './inspections.service';
import { InspectionPhotosService } from './inspection-photos.service';
import { MAX_BYTES } from './storage/image-inspection';

/**
 * The shape multer hands back. Declared locally because `@types/multer` is not a
 * dependency of this API and the upload path needs exactly three fields — adding a
 * types package to get them would be a dependency for a type alias.
 */
interface UploadedImage {
  buffer: Buffer;
  originalname?: string;
  size?: number;
  mimetype?: string;
}
import { CreateInspectionDto } from './dto/create-inspection.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import { AddRecommendationDto } from './dto/add-recommendation.dto';
import { AddInspectionPhotoDto } from './dto/add-photo.dto';
import { InspectionQueryDto } from './dto/inspection-query.dto';
import { SignoffInspectionDto } from './dto/signoff-inspection.dto';
import { DecideRecommendationDto } from './dto/decide-recommendation.dto';
import { CustomerSignoffDto } from './dto/customer-signoff.dto';
import { ToWorkOrderDto } from './dto/to-work-order.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

/**
 * CR-2026-034 (C-2) — Visual Inspection Form API core. Class guards JwtAuthGuard +
 * RbacGuard; site is derived from the visit and enforced in the service (create) and
 * on by-id ops (cross-site → NotFound; ADMIN bypass). Sign-off / customer decisions
 * / approved→work-order are C-3/C-5.
 */
@ApiTags('Inspections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacGuard)
@Controller('inspections')
export class InspectionsController {
  constructor(
    private readonly service: InspectionsService,
    private readonly photos: InspectionPhotosService,
  ) {}

  @Post()
  @RequirePermission(PERMISSIONS.INSPECTION_CREATE)
  @ApiOperation({ summary: 'Start a DRAFT inspection for a visit (snapshots the active template)' })
  @ApiCreatedResponse({ description: 'Inspection created (DRAFT)' })
  create(@Body() dto: CreateInspectionDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user);
  }

  @Get()
  @RequirePermission(PERMISSIONS.INSPECTION_VIEW)
  @ApiOperation({ summary: 'List inspections (site-scoped; filter by visit/status)' })
  @ApiOkResponse({ description: 'Paginated inspections' })
  list(@Query() query: InspectionQueryDto, @CurrentUser() user: JwtPayload) {
    return this.service.list(query, user);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.INSPECTION_VIEW)
  @ApiOperation({ summary: 'Inspection detail (items, wheels, recommendations, signatures, timeline)' })
  findById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.service.findById(id, user);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.INSPECTION_EDIT)
  @ApiOperation({ summary: 'Edit a DRAFT inspection (line results, wheel measurements, battery, flags, comments)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInspectionDto, @CurrentUser() user: JwtPayload) {
    return this.service.update(id, dto, user);
  }

  @Post(':id/recommendations')
  @RequirePermission(PERMISSIONS.INSPECTION_EDIT)
  @ApiOperation({ summary: 'Add a finding/recommendation to a DRAFT inspection' })
  addRecommendation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddRecommendationDto, @CurrentUser() user: JwtPayload) {
    return this.service.addRecommendation(id, dto, user);
  }

  // ─── Photographs (CR-2026-087, reworked by CR-2026-093) ───────────────────

  /**
   * Multipart upload — what a phone camera or a file picker uses.
   *
   * Memory storage, capped at the same 10 MB the validator enforces, so an oversized
   * file is refused at the boundary rather than after being written anywhere.
   */
  @Post(':id/photos/upload')
  @RequirePermission(PERMISSIONS.INSPECTION_EDIT)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload an inspection photograph (JPEG, PNG or WebP, max 10 MB)' })
  uploadPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedImage | undefined,
    @Body() body: { caption?: string; category?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.photos.upload(id, file, { caption: body?.caption, category: body?.category }, user);
  }

  /**
   * The original CR-2026-087 shape, kept working for clients that still post a base64
   * data URL. The bytes no longer land in a database column — they go through the same
   * validation and storage as an uploaded file.
   */
  @Post(':id/photos')
  @RequirePermission(PERMISSIONS.INSPECTION_EDIT)
  @ApiOperation({ summary: 'Attach a photograph as a base64 data URL (legacy shape)' })
  addPhoto(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddInspectionPhotoDto, @CurrentUser() user: JwtPayload) {
    return this.photos.addFromDataUrl(id, dto.imageData, dto.caption, user);
  }

  @Get(':id/photos')
  @RequirePermission(PERMISSIONS.INSPECTION_VIEW)
  @ApiOperation({ summary: 'List photograph metadata for an inspection' })
  listPhotos(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.photos.list(id, user);
  }

  /**
   * The bytes themselves.
   *
   * Authorised on every request, and served from an application endpoint rather than a
   * static path: an inspection photograph must never be reachable by anyone who can
   * guess a number.
   */
  @Get(':id/photos/:photoId/file')
  @RequirePermission(PERMISSIONS.INSPECTION_VIEW)
  @ApiOperation({ summary: 'Fetch an inspection photograph' })
  async photoFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    const { body, mimeType, filename } = await this.photos.readBytes(id, photoId, user);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(body.length));
    // private: this is customer property, and no shared cache should hold it.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
  }

  @Patch(':id/photos/:photoId')
  @RequirePermission(PERMISSIONS.INSPECTION_EDIT)
  @ApiOperation({ summary: 'Change a photograph caption, category, order or primary flag' })
  updatePhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @Body() patch: { caption?: string; category?: string; sortOrder?: number; isPrimary?: boolean },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.photos.updateMeta(id, photoId, patch ?? {}, user);
  }

  @Delete(':id/photos/:photoId')
  @RequirePermission(PERMISSIONS.INSPECTION_EDIT)
  @ApiOperation({ summary: 'Remove a DRAFT photograph. Completed evidence is corrected, not deleted.' })
  deletePhoto(@Param('id', ParseUUIDPipe) id: string, @Param('photoId', ParseUUIDPipe) photoId: string, @CurrentUser() user: JwtPayload) {
    return this.photos.remove(id, photoId, user);
  }

  @Post(':id/photos/:photoId/correct')
  @RequirePermission(PERMISSIONS.INSPECTION_SIGNOFF)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Supersede a completed photograph, preserving the original' })
  correctPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @UploadedFile() file: UploadedImage | undefined,
    @Body() body: { reason?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.photos.correct(id, photoId, file, body?.reason ?? '', user);
  }

  @Post(':id/complete')
  @RequirePermission(PERMISSIONS.INSPECTION_EDIT)
  @ApiOperation({ summary: 'Mark a DRAFT inspection COMPLETED' })
  complete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.service.complete(id, user);
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.INSPECTION_EDIT)
  @ApiOperation({ summary: 'Cancel a DRAFT or COMPLETED inspection' })
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.service.cancel(id, user);
  }

  // ─── C-3: sign-off + customer decisions ──────────────────────────────────────

  @Post(':id/signoff')
  @RequirePermission(PERMISSIONS.INSPECTION_SIGNOFF)
  @ApiOperation({ summary: 'Senior-tech sign-off (COMPLETED → SIGNED_OFF; locks results)' })
  signoff(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SignoffInspectionDto, @CurrentUser() user: JwtPayload) {
    return this.service.signoff(id, user, dto);
  }

  @Patch(':id/recommendations/:rid/decision')
  @RequirePermission(PERMISSIONS.INSPECTION_DECISION)
  @ApiOperation({ summary: 'Record the customer decision on a recommendation (APPROVED/DECLINED/DEFERRED)' })
  decide(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rid', ParseUUIDPipe) rid: string,
    @Body() dto: DecideRecommendationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.decideRecommendation(id, rid, user, dto);
  }

  @Post(':id/customer-signoff')
  @RequirePermission(PERMISSIONS.INSPECTION_DECISION)
  @ApiOperation({ summary: 'Capture customer sign-off (drawn or typed) → CLOSED' })
  customerSignoff(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CustomerSignoffDto, @CurrentUser() user: JwtPayload) {
    return this.service.customerSignoff(id, user, dto);
  }

  @Post(':id/recommendations/:rid/to-work-order')
  @RequirePermission(PERMISSIONS.INSPECTION_DECISION)
  @ApiOperation({ summary: 'Turn an APPROVED recommendation into a service-order item (C-5)' })
  toWorkOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rid', ParseUUIDPipe) rid: string,
    @Body() dto: ToWorkOrderDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.recommendationToWorkOrder(id, rid, user, dto);
  }
}
