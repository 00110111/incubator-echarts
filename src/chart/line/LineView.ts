/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

// FIXME step not support polar

import {__DEV__} from '../../config';
import * as zrUtil from 'zrender/src/core/util';
import SymbolDraw from '../helper/SymbolDraw';
import SymbolClz from '../helper/Symbol';
import lineAnimationDiff from './lineAnimationDiff';
import * as graphic from '../../util/graphic';
import * as modelUtil from '../../util/model';
import {ECPolyline, ECPolygon} from './poly';
import ChartView from '../../view/Chart';
import {prepareDataCoordInfo, getStackedOnPoint} from './helper';
import {createGridClipPath, createPolarClipPath} from '../helper/createClipPathFromCoordSys';
import LineSeriesModel, { LineSeriesOption } from './LineSeries';
import type GlobalModel from '../../model/Global';
import type ExtensionAPI from '../../ExtensionAPI';
// TODO
import Cartesian2D from '../../coord/cartesian/Cartesian2D';
import Polar from '../../coord/polar/Polar';
import type List from '../../data/List';
import type { VisualMeta } from '../../component/visualMap/VisualMapModel';
import type { Payload, Dictionary, ColorString } from '../../util/types';
import type OrdinalScale from '../../scale/Ordinal';
import type Axis2D from '../../coord/cartesian/Axis2D';


type PolarArea = ReturnType<Polar['getArea']>
type Cartesian2DArea = ReturnType<Cartesian2D['getArea']>

interface SymbolExtended extends SymbolClz {
    __temp: boolean
}

function isPointsSame(points1: number[][], points2: number[][]) {
    if (points1.length !== points2.length) {
        return;
    }
    for (var i = 0; i < points1.length; i++) {
        var p1 = points1[i];
        var p2 = points2[i];
        if (p1[0] !== p2[0] || p1[1] !== p2[1]) {
            return;
        }
    }
    return true;
}

function getSmooth(smooth: number | boolean) {
    return typeof smooth === 'number' ? smooth : (smooth ? 0.5 : 0);
}

function getStackedOnPoints(
    coordSys: Cartesian2D | Polar,
    data: List,
    dataCoordInfo: ReturnType<typeof prepareDataCoordInfo>
) {
    if (!dataCoordInfo.valueDim) {
        return [];
    }

    var points = [];
    for (var idx = 0, len = data.count(); idx < len; idx++) {
        points.push(getStackedOnPoint(dataCoordInfo, coordSys, data, idx));
    }

    return points;
}

function turnPointsIntoStep(
    points: number[][],
    coordSys: Cartesian2D | Polar,
    stepTurnAt: 'start' | 'end' | 'middle'
) {
    var baseAxis = coordSys.getBaseAxis();
    var baseIndex = baseAxis.dim === 'x' || baseAxis.dim === 'radius' ? 0 : 1;

    var stepPoints = [];
    for (var i = 0; i < points.length - 1; i++) {
        var nextPt = points[i + 1];
        var pt = points[i];
        stepPoints.push(pt);

        var stepPt = [];
        switch (stepTurnAt) {
            case 'end':
                stepPt[baseIndex] = nextPt[baseIndex];
                stepPt[1 - baseIndex] = pt[1 - baseIndex];
                // default is start
                stepPoints.push(stepPt);
                break;
            case 'middle':
                // default is start
                var middle = (pt[baseIndex] + nextPt[baseIndex]) / 2;
                var stepPt2 = [];
                stepPt[baseIndex] = stepPt2[baseIndex] = middle;
                stepPt[1 - baseIndex] = pt[1 - baseIndex];
                stepPt2[1 - baseIndex] = nextPt[1 - baseIndex];
                stepPoints.push(stepPt);
                stepPoints.push(stepPt2);
                break;
            default:
                stepPt[baseIndex] = pt[baseIndex];
                stepPt[1 - baseIndex] = nextPt[1 - baseIndex];
                // default is start
                stepPoints.push(stepPt);
        }
    }
    // Last points
    points[i] && stepPoints.push(points[i]);
    return stepPoints;
}

function getVisualGradient(
    data: List,
    coordSys: Cartesian2D | Polar
) {
    var visualMetaList = data.getVisual('visualMeta') as VisualMeta[];
    if (!visualMetaList || !visualMetaList.length || !data.count()) {
        // When data.count() is 0, gradient range can not be calculated.
        return;
    }

    if (coordSys.type !== 'cartesian2d') {
        if (__DEV__) {
            console.warn('Visual map on line style is only supported on cartesian2d.');
        }
        return;
    }

    var coordDim: 'x' | 'y';
    var visualMeta;

    for (var i = visualMetaList.length - 1; i >= 0; i--) {
        var dimIndex = visualMetaList[i].dimension;
        var dimName = data.dimensions[dimIndex];
        var dimInfo = data.getDimensionInfo(dimName);
        coordDim = (dimInfo && dimInfo.coordDim) as 'x' | 'y';
        // Can only be x or y
        if (coordDim === 'x' || coordDim === 'y') {
            visualMeta = visualMetaList[i];
            break;
        }
    }

    if (!visualMeta) {
        if (__DEV__) {
            console.warn('Visual map on line style only support x or y dimension.');
        }
        return;
    }

    // If the area to be rendered is bigger than area defined by LinearGradient,
    // the canvas spec prescribes that the color of the first stop and the last
    // stop should be used. But if two stops are added at offset 0, in effect
    // browsers use the color of the second stop to render area outside
    // LinearGradient. So we can only infinitesimally extend area defined in
    // LinearGradient to render `outerColors`.

    var axis = coordSys.getAxis(coordDim);

    interface ColorStop {
        offset: number
        coord?: number
        color: ColorString
    }
    // dataToCoor mapping may not be linear, but must be monotonic.
    var colorStops: ColorStop[] = zrUtil.map(visualMeta.stops, function (stop) {
        return {
            offset: 0,
            coord: axis.toGlobalCoord(axis.dataToCoord(stop.value)),
            color: stop.color
        };
    });
    var stopLen = colorStops.length;
    var outerColors = visualMeta.outerColors.slice();

    if (stopLen && colorStops[0].coord > colorStops[stopLen - 1].coord) {
        colorStops.reverse();
        outerColors.reverse();
    }

    var tinyExtent = 10; // Arbitrary value: 10px
    var minCoord = colorStops[0].coord - tinyExtent;
    var maxCoord = colorStops[stopLen - 1].coord + tinyExtent;
    var coordSpan = maxCoord - minCoord;

    if (coordSpan < 1e-3) {
        return 'transparent';
    }

    zrUtil.each(colorStops, function (stop) {
        stop.offset = (stop.coord - minCoord) / coordSpan;
    });
    colorStops.push({
        offset: stopLen ? colorStops[stopLen - 1].offset : 0.5,
        color: outerColors[1] || 'transparent'
    });
    colorStops.unshift({ // notice colorStops.length have been changed.
        offset: stopLen ? colorStops[0].offset : 0.5,
        color: outerColors[0] || 'transparent'
    });

    // zrUtil.each(colorStops, function (colorStop) {
    //     // Make sure each offset has rounded px to avoid not sharp edge
    //     colorStop.offset = (Math.round(colorStop.offset * (end - start) + start) - start) / (end - start);
    // });

    var gradient = new graphic.LinearGradient(0, 0, 0, 0, colorStops, true);
    gradient[coordDim] = minCoord;
    gradient[coordDim + '2' as 'x2' | 'y2'] = maxCoord;

    return gradient;
}

function getIsIgnoreFunc(
    seriesModel: LineSeriesModel,
    data: List,
    coordSys: Cartesian2D
) {
    var showAllSymbol = seriesModel.get('showAllSymbol');
    var isAuto = showAllSymbol === 'auto';

    if (showAllSymbol && !isAuto) {
        return;
    }

    var categoryAxis = coordSys.getAxesByScale('ordinal')[0];
    if (!categoryAxis) {
        return;
    }

    // Note that category label interval strategy might bring some weird effect
    // in some scenario: users may wonder why some of the symbols are not
    // displayed. So we show all symbols as possible as we can.
    if (isAuto
        // Simplify the logic, do not determine label overlap here.
        && canShowAllSymbolForCategory(categoryAxis, data)
    ) {
        return;
    }

    // Otherwise follow the label interval strategy on category axis.
    var categoryDataDim = data.mapDimension(categoryAxis.dim);
    var labelMap: Dictionary<1> = {};

    zrUtil.each(categoryAxis.getViewLabels(), function (labelItem) {
        labelMap[labelItem.tickValue] = 1;
    });

    return function (dataIndex: number) {
        return !labelMap.hasOwnProperty(data.get(categoryDataDim, dataIndex));
    };
}

function canShowAllSymbolForCategory(
    categoryAxis: Axis2D,
    data: List
) {
    // In mose cases, line is monotonous on category axis, and the label size
    // is close with each other. So we check the symbol size and some of the
    // label size alone with the category axis to estimate whether all symbol
    // can be shown without overlap.
    var axisExtent = categoryAxis.getExtent();
    var availSize = Math.abs(axisExtent[1] - axisExtent[0]) / (categoryAxis.scale as OrdinalScale).count();
    isNaN(availSize) && (availSize = 0); // 0/0 is NaN.

    // Sampling some points, max 5.
    var dataLen = data.count();
    var step = Math.max(1, Math.round(dataLen / 5));
    for (var dataIndex = 0; dataIndex < dataLen; dataIndex += step) {
        if (SymbolClz.getSymbolSize(
                data, dataIndex
            // Only for cartesian, where `isHorizontal` exists.
            )[categoryAxis.isHorizontal() ? 1 : 0]
            // Empirical number
            * 1.5 > availSize
        ) {
            return false;
        }
    }

    return true;
}

function createLineClipPath(
    coordSys: Cartesian2D | Polar,
    hasAnimation: boolean,
    seriesModel: LineSeriesModel
) {
    if (coordSys.type === 'cartesian2d') {
        var isHorizontal = coordSys.getBaseAxis().isHorizontal();
        var clipPath = createGridClipPath(coordSys, hasAnimation, seriesModel);
        // Expand clip shape to avoid clipping when line value exceeds axis
        if (!seriesModel.get('clip', true)) {
            var rectShape = clipPath.shape;
            var expandSize = Math.max(rectShape.width, rectShape.height);
            if (isHorizontal) {
                rectShape.y -= expandSize;
                rectShape.height += expandSize * 2;
            }
            else {
                rectShape.x -= expandSize;
                rectShape.width += expandSize * 2;
            }
        }
        return clipPath;
    }
    else {
        return createPolarClipPath(coordSys, hasAnimation, seriesModel);
    }

}

class LineView extends ChartView {

    static readonly type = 'line'

    _symbolDraw: SymbolDraw

    _lineGroup: graphic.Group
    _coordSys: Cartesian2D | Polar

    _polyline: ECPolyline
    _polygon: ECPolygon

    _stackedOnPoints: number[][]
    _points: number[][]

    _step: LineSeriesOption['step']
    _valueOrigin: LineSeriesOption['areaStyle']['origin']

    _clipShapeForSymbol: {
        contain(x: number, y: number): boolean
    }

    _data: List

    init() {
        var lineGroup = new graphic.Group();

        var symbolDraw = new SymbolDraw();
        this.group.add(symbolDraw.group);

        this._symbolDraw = symbolDraw;
        this._lineGroup = lineGroup;
    }

    render(seriesModel: LineSeriesModel, ecModel: GlobalModel, api: ExtensionAPI) {
        var coordSys = seriesModel.coordinateSystem;
        var group = this.group;
        var data = seriesModel.getData();
        var lineStyleModel = seriesModel.getModel('lineStyle');
        var areaStyleModel = seriesModel.getModel('areaStyle');

        var points = data.mapArray(data.getItemLayout);

        var isCoordSysPolar = coordSys.type === 'polar';
        var prevCoordSys = this._coordSys;

        var symbolDraw = this._symbolDraw;
        var polyline = this._polyline;
        var polygon = this._polygon;

        var lineGroup = this._lineGroup;

        var hasAnimation = seriesModel.get('animation');

        var isAreaChart = !areaStyleModel.isEmpty();

        var valueOrigin = areaStyleModel.get('origin');
        var dataCoordInfo = prepareDataCoordInfo(coordSys, data, valueOrigin);

        var stackedOnPoints = getStackedOnPoints(coordSys, data, dataCoordInfo);

        var showSymbol = seriesModel.get('showSymbol');

        var isIgnoreFunc = showSymbol && !isCoordSysPolar
            && getIsIgnoreFunc(seriesModel, data, coordSys as Cartesian2D);

        // Remove temporary symbols
        var oldData = this._data;
        oldData && oldData.eachItemGraphicEl(function (el: SymbolExtended, idx) {
            if (el.__temp) {
                group.remove(el);
                oldData.setItemGraphicEl(idx, null);
            }
        });

        // Remove previous created symbols if showSymbol changed to false
        if (!showSymbol) {
            symbolDraw.remove();
        }

        group.add(lineGroup);

        // FIXME step not support polar
        var step = !isCoordSysPolar ? seriesModel.get('step') : false;
        var clipShapeForSymbol: PolarArea | Cartesian2DArea;
        if (coordSys && coordSys.getArea && seriesModel.get('clip', true)) {
            clipShapeForSymbol = coordSys.getArea();
            // Avoid float number rounding error for symbol on the edge of axis extent.
            // See #7913 and `test/dataZoom-clip.html`.
            if ((clipShapeForSymbol as Cartesian2DArea).width != null) {
                (clipShapeForSymbol as Cartesian2DArea).x -= 0.1;
                (clipShapeForSymbol as Cartesian2DArea).y -= 0.1;
                (clipShapeForSymbol as Cartesian2DArea).width += 0.2;
                (clipShapeForSymbol as Cartesian2DArea).height += 0.2;
            }
            else if ((clipShapeForSymbol as PolarArea).r0) {
                (clipShapeForSymbol as PolarArea).r0 -= 0.5;
                (clipShapeForSymbol as PolarArea).r += 0.5;
            }
        }
        this._clipShapeForSymbol = clipShapeForSymbol;
        // Initialization animation or coordinate system changed
        if (
            !(polyline && prevCoordSys.type === coordSys.type && step === this._step)
        ) {
            showSymbol && symbolDraw.updateData(data, {
                isIgnore: isIgnoreFunc,
                clipShape: clipShapeForSymbol
            });

            if (step) {
                // TODO If stacked series is not step
                points = turnPointsIntoStep(points, coordSys, step);
                stackedOnPoints = turnPointsIntoStep(stackedOnPoints, coordSys, step);
            }

            polyline = this._newPolyline(points);
            if (isAreaChart) {
                polygon = this._newPolygon(
                    points, stackedOnPoints
                );
            }
            lineGroup.setClipPath(createLineClipPath(coordSys, true, seriesModel));
        }
        else {
            if (isAreaChart && !polygon) {
                // If areaStyle is added
                polygon = this._newPolygon(
                    points, stackedOnPoints
                );
            }
            else if (polygon && !isAreaChart) {
                // If areaStyle is removed
                lineGroup.remove(polygon);
                polygon = this._polygon = null;
            }

            // Update clipPath
            lineGroup.setClipPath(createLineClipPath(coordSys, false, seriesModel));

            // Always update, or it is wrong in the case turning on legend
            // because points are not changed
            showSymbol && symbolDraw.updateData(data, {
                isIgnore: isIgnoreFunc,
                clipShape: clipShapeForSymbol
            });

            // Stop symbol animation and sync with line points
            // FIXME performance?
            data.eachItemGraphicEl(function (el) {
                el.stopAnimation(true);
            });

            // In the case data zoom triggerred refreshing frequently
            // Data may not change if line has a category axis. So it should animate nothing
            if (!isPointsSame(this._stackedOnPoints, stackedOnPoints)
                || !isPointsSame(this._points, points)
            ) {
                if (hasAnimation) {
                    this._updateAnimation(
                        data, stackedOnPoints, coordSys, api, step, valueOrigin
                    );
                }
                else {
                    // Not do it in update with animation
                    if (step) {
                        // TODO If stacked series is not step
                        points = turnPointsIntoStep(points, coordSys, step);
                        stackedOnPoints = turnPointsIntoStep(stackedOnPoints, coordSys, step);
                    }

                    polyline.setShape({
                        points: points
                    });
                    polygon && polygon.setShape({
                        points: points,
                        stackedOnPoints: stackedOnPoints
                    });
                }
            }
        }

        var visualColor = getVisualGradient(data, coordSys) || data.getVisual('color');

        polyline.useStyle(zrUtil.defaults(
            // Use color in lineStyle first
            lineStyleModel.getLineStyle(),
            {
                fill: 'none',
                stroke: visualColor,
                lineJoin: 'bevel'
            }
        ));

        var smooth = getSmooth(seriesModel.get('smooth'));
        polyline.setShape({
            smooth: smooth,
            smoothMonotone: seriesModel.get('smoothMonotone'),
            connectNulls: seriesModel.get('connectNulls')
        });

        if (polygon) {
            var stackedOnSeries = data.getCalculationInfo('stackedOnSeries');
            var stackedOnSmooth = 0;

            polygon.useStyle(zrUtil.defaults(
                areaStyleModel.getAreaStyle(),
                {
                    fill: visualColor,
                    opacity: 0.7,
                    lineJoin: 'bevel'
                }
            ));

            if (stackedOnSeries) {
                stackedOnSmooth = getSmooth(stackedOnSeries.get('smooth'));
            }

            polygon.setShape({
                smooth: smooth,
                stackedOnSmooth: stackedOnSmooth,
                smoothMonotone: seriesModel.get('smoothMonotone'),
                connectNulls: seriesModel.get('connectNulls')
            });
        }

        this._data = data;
        // Save the coordinate system for transition animation when data changed
        this._coordSys = coordSys;
        this._stackedOnPoints = stackedOnPoints;
        this._points = points;
        this._step = step;
        this._valueOrigin = valueOrigin;
    }

    dispose() {}

    highlight(
        seriesModel: LineSeriesModel,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        payload: Payload
    ) {
        var data = seriesModel.getData();
        var dataIndex = modelUtil.queryDataIndex(data, payload);

        if (!(dataIndex instanceof Array) && dataIndex != null && dataIndex >= 0) {
            var symbol = data.getItemGraphicEl(dataIndex) as SymbolClz;
            if (!symbol) {
                // Create a temporary symbol if it is not exists
                var pt = data.getItemLayout(dataIndex) as number[];
                if (!pt) {
                    // Null data
                    return;
                }
                // fix #11360: should't draw symbol outside clipShapeForSymbol
                if (this._clipShapeForSymbol && !this._clipShapeForSymbol.contain(pt[0], pt[1])) {
                    return;
                }
                symbol = new SymbolClz(data, dataIndex);
                symbol.position = pt;
                symbol.setZ(
                    seriesModel.get('zlevel'),
                    seriesModel.get('z')
                );
                symbol.ignore = isNaN(pt[0]) || isNaN(pt[1]);
                (symbol as SymbolExtended).__temp = true;
                data.setItemGraphicEl(dataIndex, symbol);

                // Stop scale animation
                symbol.stopSymbolAnimation(true);

                this.group.add(symbol);
            }
            symbol.highlight();
        }
        else {
            // Highlight whole series
            ChartView.prototype.highlight.call(
                this, seriesModel, ecModel, api, payload
            );
        }
    }

    downplay(
        seriesModel: LineSeriesModel,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        payload: Payload
    ) {
        var data = seriesModel.getData();
        var dataIndex = modelUtil.queryDataIndex(data, payload) as number;
        if (dataIndex != null && dataIndex >= 0) {
            var symbol = data.getItemGraphicEl(dataIndex) as SymbolExtended;
            if (symbol) {
                if (symbol.__temp) {
                    data.setItemGraphicEl(dataIndex, null);
                    this.group.remove(symbol);
                }
                else {
                    symbol.downplay();
                }
            }
        }
        else {
            // FIXME
            // can not downplay completely.
            // Downplay whole series
            ChartView.prototype.downplay.call(
                this, seriesModel, ecModel, api, payload
            );
        }
    }

    _newPolyline(points: number[][]) {
        var polyline = this._polyline;
        // Remove previous created polyline
        if (polyline) {
            this._lineGroup.remove(polyline);
        }

        polyline = new ECPolyline({
            shape: {
                points: points
            },
            silent: true,
            z2: 10
        });

        this._lineGroup.add(polyline);

        this._polyline = polyline;

        return polyline;
    }

    _newPolygon(points: number[][], stackedOnPoints: number[][]) {
        var polygon = this._polygon;
        // Remove previous created polygon
        if (polygon) {
            this._lineGroup.remove(polygon);
        }

        polygon = new ECPolygon({
            shape: {
                points: points,
                stackedOnPoints: stackedOnPoints
            },
            silent: true
        });

        this._lineGroup.add(polygon);

        this._polygon = polygon;
        return polygon;
    }

    /**
     * @private
     */
    // FIXME Two value axis
    _updateAnimation(
        data: List,
        stackedOnPoints: number[][],
        coordSys: Cartesian2D | Polar,
        api: ExtensionAPI,
        step: LineSeriesOption['step'],
        valueOrigin: LineSeriesOption['areaStyle']['origin']
    ) {
        var polyline = this._polyline;
        var polygon = this._polygon;
        var seriesModel = data.hostModel;

        var diff = lineAnimationDiff(
            this._data, data,
            this._stackedOnPoints, stackedOnPoints,
            this._coordSys, coordSys,
            this._valueOrigin, valueOrigin
        );

        var current = diff.current;
        var stackedOnCurrent = diff.stackedOnCurrent;
        var next = diff.next;
        var stackedOnNext = diff.stackedOnNext;
        if (step) {
            // TODO If stacked series is not step
            current = turnPointsIntoStep(diff.current, coordSys, step);
            stackedOnCurrent = turnPointsIntoStep(diff.stackedOnCurrent, coordSys, step);
            next = turnPointsIntoStep(diff.next, coordSys, step);
            stackedOnNext = turnPointsIntoStep(diff.stackedOnNext, coordSys, step);
        }
        // `diff.current` is subset of `current` (which should be ensured by
        // turnPointsIntoStep), so points in `__points` can be updated when
        // points in `current` are update during animation.
        (polyline.shape as any).__points = diff.current;
        polyline.shape.points = current;

        graphic.updateProps(polyline, {
            shape: {
                points: next
            }
        }, seriesModel);

        if (polygon) {
            polygon.setShape({
                points: current,
                stackedOnPoints: stackedOnCurrent
            });
            graphic.updateProps(polygon, {
                shape: {
                    points: next,
                    stackedOnPoints: stackedOnNext
                }
            }, seriesModel);
        }

        var updatedDataInfo: {
            el: SymbolExtended,
            ptIdx: number
        }[] = [];
        var diffStatus = diff.status;

        for (var i = 0; i < diffStatus.length; i++) {
            var cmd = diffStatus[i].cmd;
            if (cmd === '=') {
                var el = data.getItemGraphicEl(diffStatus[i].idx1) as SymbolExtended;
                if (el) {
                    updatedDataInfo.push({
                        el: el,
                        ptIdx: i    // Index of points
                    });
                }
            }
        }

        if (polyline.animators && polyline.animators.length) {
            polyline.animators[0].during(function () {
                for (var i = 0; i < updatedDataInfo.length; i++) {
                    var el = updatedDataInfo[i].el;
                    el.attr('position', (polyline.shape as any).__points[updatedDataInfo[i].ptIdx]);
                }
            });
        }
    }

    remove(ecModel: GlobalModel) {
        var group = this.group;
        var oldData = this._data;
        this._lineGroup.removeAll();
        this._symbolDraw.remove(true);
        // Remove temporary created elements when highlighting
        oldData && oldData.eachItemGraphicEl(function (el: SymbolExtended, idx) {
            if (el.__temp) {
                group.remove(el);
                oldData.setItemGraphicEl(idx, null);
            }
        });

        this._polyline =
            this._polygon =
            this._coordSys =
            this._points =
            this._stackedOnPoints =
            this._data = null;
    }
}

ChartView.registerClass(LineView);

export default ChartView;